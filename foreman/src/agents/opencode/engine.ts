// The OpenCode engine: one `opencode serve` process per turn (like one Codex app-server per turn),
// driven over its HTTP + SSE API. The agent's session is durable in opencode's own store, so its next
// turn resumes it in a fresh process.
//
// What the agent may do is decided the same way as for Claude/Codex agents:
// - every edit and command raises a permission ask (inline config: permission edit/bash "ask"),
//   which goes through AgentCraft's policy (policy.ts) and, if needed, an in-game prompt
// - reads and the task board stay free (opencode allows its native reads and our MCP tools)
// - the team tools (send_message, ask_user, update_task...) are an in-process MCP server the engine
//   answers directly, with the same TurnHandle guards as the other engines
// - none of opencode's web/sub-agent/native-question tools: they are switched off (webfetch,
//   websearch, question, task), so questions go through ask_user
// - commands run with the git safety environment (no push, no hooks, the agent's own identity)
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { OpenCodeConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';
import { OPENCODE_NOT_FOUND, findOpenCode } from './find.js';
import { MCP_SERVER, startTeamMcpServer } from './mcp.js';
import { OpenCodeServer, freePort } from './server.js';
import { OpenCodeStreamMapper } from './stream.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function capture(bin: string, args: string[]): string {
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const r = viaCmd
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${bin}" ${args.join(' ')}`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300));
  return r.stdout ?? '';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface OpenCodeEngineOptions {
  /** the opencode CLI (tests: node with a fake server script in `args`) */
  bin?: string;
  /** arguments before the `serve` subcommand */
  args?: string[];
}

function notes(role: Role): string {
  return [
    '',
    '# Working in AgentCraft (OpenCode)',
    `- The AgentCraft team tools (${role === 'lead' ? 'send_message, ask_user, write_memory, read_memory, update_task, report_status, list_tasks, create_task, request_merge' : 'send_message, ask_user, write_memory, read_memory, update_task, report_status, list_tasks'}) are MCP tools (prefixed "${MCP_SERVER}_"): call them directly. They are how the team and ${userName()} see your work; plain text only shows on your monitor.`,
    `- Every command and every file edit is checked against AgentCraft's policy, and anything it cannot allow by itself is shown to ${userName()}, who may deny it. Never work around a denial: find another way or use ask_user.`,
    `- Do not spawn sub-agents and do not search the web; ask questions only with the ask_user tool.`,
    role === 'lead' ? '- You are read-only: never modify files or run commands that change anything.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export class OpenCodeEngine implements Engine {
  readonly id = 'opencode' as const;
  readonly label = 'OpenCode';

  constructor(
    private fm: Foreman,
    private cfg: OpenCodeConfig,
    private opts: OpenCodeEngineOptions = {},
  ) {}

  private bin(): string | undefined {
    return this.opts.bin ?? findOpenCode(this.cfg.path);
  }

  model(role: Role): string {
    return (role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel) ?? 'default';
  }

  authFailedMessage(detail: string): string {
    return `OpenCode authentication failed (${detail}). Run \`opencode auth login\`, then restart the Foreman.`;
  }

  async checkAuth(): Promise<AuthCheck> {
    const bin = this.bin();
    if (!bin) return { ok: false, message: OPENCODE_NOT_FOUND };
    try {
      const rows = capture(bin, [...(this.opts.args ?? []), 'auth', 'list'])
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^provider\b/i.test(l));
      return { ok: true, account: rows[0] ? rows[0].split(/\s{2,}/)[0]! : 'opencode' };
    } catch (e) {
      return { ok: false, message: `OpenCode check failed: ${errorText(e)}. Check that \`opencode\` works and you are logged in (\`opencode auth login\`), then restart the Foreman. The sim backend still works.` };
    }
  }

  /** The inline config for one turn's server: permissions, off tools, and the model override. */
  private config(role: Role): string {
    const model = role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
    return JSON.stringify({
      ...(model ? { model } : {}),
      // every edit and command asks (policy + in-game prompts); reads and the board stay free
      permission: { edit: 'ask', bash: 'ask' },
      // no web, no sub-agents, no native question prompt (ask_user is the team tool)
      tools: { webfetch: false, websearch: false, question: false, task: false },
    });
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const bin = this.bin();
    if (!bin) throw new Error(OPENCODE_NOT_FOUND);
    const { agentId, role, cwd, abort } = spec;
    const mapper = new OpenCodeStreamMapper(this.fm, agentId, cwd, role, MCP_SERVER);
    const mcp = await startTeamMcpServer(MCP_SERVER, spec.tools);
    const server = new OpenCodeServer(bin, await freePort(), {
      cwd,
      env: spec.env,
      password: randomUUID(),
      config: this.config(role),
      ...(this.opts.args ? { args: this.opts.args } : {}),
      onStderr: (s) => this.fm.log.debug(`[${agentId} opencode] ${s.trim().slice(0, 300)}`),
    });
    spec.onProcess(server.child);

    const controller = new AbortController();
    let sessionId = spec.resume;
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));

    const onAbort = () => {
      if (sessionId) void server.interrupt(sessionId).catch(() => undefined);
      finish();
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener('abort', onAbort, { once: true });

    const replyPermission = async (data: any): Promise<void> => {
      const resources = (Array.isArray(data.resources) ? data.resources : []).map(String);
      let allow = false;
      try {
        if (data.action === 'shell') {
          allow = (await spec.permission('Bash', { command: resources.join(' && ') }, abort.signal)).allow;
        } else if (data.action === 'edit') {
          const tool = data.metadata?.files?.[0]?.status === 'added' ? 'Write' : 'Edit';
          allow = true;
          for (const p of resources) {
            if (!(await spec.permission(tool, { file_path: path.resolve(cwd, p) }, abort.signal)).allow) {
              allow = false;
              break;
            }
          }
        } else {
          // anything else opencode asks about goes through the policy too (it will prompt the user)
          allow = (await spec.permission(String(data.action), { command: resources.join(' ') }, abort.signal)).allow;
        }
      } catch {
        allow = false;
      }
      if (sessionId) await server.replyPermission(sessionId, String(data.id), allow).catch(() => undefined);
    };

    try {
      await server.ready(60_000);
      await server.connectMcp(MCP_SERVER, mcp.url);
      if (sessionId && !(await server.getSession(sessionId))) sessionId = undefined;
      if (!sessionId) {
        const task = this.fm.agent(agentId)?.taskId;
        sessionId = await server.createSession(cwd, `AgentCraft · ${this.fm.nameOf(agentId)}${task ? ` · ${task}` : ''}`);
      }
      spec.onSession(sessionId);
      mapper.stats.sessionId = sessionId;
      await server.setInstructions(sessionId, `${spec.instructions}${notes(role)}`);
      if (abort.signal.aborted) return mapper.stats;

      let opened!: () => void;
      const open = new Promise<void>((r) => (opened = r));
      const events = server.events(
        sessionId,
        controller.signal,
        async (type, data) => {
          if (type === 'permission.asked') {
            await replyPermission(data);
            return;
          }
          mapper.handle(type, data);
          if (type === 'session.step.started' && mapper.model) spec.onModel?.(mapper.model);
          if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) {
            mapper.finish(type, data);
            finish();
          }
        },
        opened,
      );
      events.catch((e) => {
        if (!controller.signal.aborted) this.fm.log.debug(`[${agentId} opencode] event stream ended: ${errorText(e)}`);
      });
      // the subscription is open (or we gave it 2s): now the prompt, so no early event is missed
      await Promise.race([open, new Promise((r) => setTimeout(r, 2000))]);

      await server.prompt(sessionId, spec.prompt);
      // until the turn ends, or the process dies
      const died = server.exited.then(() => {
        if (!controller.signal.aborted && !abort.signal.aborted) throw new Error(`opencode serve exited during the turn${server.stderr().length ? `: ${truncate(server.stderr().slice(-3).join(' | '), 300)}` : ''}`);
      });
      await Promise.race([finished, died]);
      const info = await server.getSession(sessionId).catch(() => undefined);
      if (typeof info?.cost === 'number') mapper.stats.costUsd = info.cost;
      return mapper.stats;
    } finally {
      abort.signal.removeEventListener('abort', onAbort);
      controller.abort();
      server.close();
      await mcp.close();
    }
  }
}

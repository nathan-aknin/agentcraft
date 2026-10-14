// Map opencode /api/event events -> agent.log entries + agent state/station (like claude/stream.ts).
import type { Foreman } from '../../foreman.js';
import { firstLine, tailLines, truncate } from '../../util/text.js';
import { toolActivity } from '../activity.js';
import type { Role, TurnStats } from '../engine.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** opencode's native tool names -> the Claude vocabulary toolActivity (and the policy) understand. */
const NATIVE: Record<string, string> = { shell: 'Bash', write: 'Write', edit: 'Edit', read: 'Read', glob: 'Glob', grep: 'Grep', list: 'LS', patch: 'Edit', todowrite: 'TodoWrite', webfetch: 'WebFetch', websearch: 'WebSearch' };

export class OpenCodeStreamMapper {
  readonly stats: TurnStats = { isError: false, errors: [] };
  /** the model the current step runs (e.g. "claude-sonnet-4-5"), for the nameplate */
  model: string | undefined;
  private calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private steps = 0;
  private tokens = 0;
  private finalText: string | undefined;

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: Role,
    private mcpServer: string,
  ) {}

  private claudeName(name: string): string {
    const prefix = `${this.mcpServer}_`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : (NATIVE[name] ?? name);
  }

  private set(patch: { state?: any; station?: any; activity?: string }): void {
    const a = this.fm.agent(this.agentId);
    // a pending question/permission keeps the agent at the user
    if (a?.state === 'waiting_user' && patch.state !== 'waiting_user') return;
    this.fm.setAgent(this.agentId, patch);
  }

  private refreshSoon(): void {
    if (this.role !== 'worker') return;
    const repoId = this.fm.agent(this.agentId)?.repoId;
    if (repoId) this.fm.repos.scheduleRefresh(repoId, 1500);
  }

  handle(type: string, data: any): void {
    const fm = this.fm;
    const id = this.agentId;
    switch (type) {
      case 'session.step.started': {
        this.steps++;
        const m = data?.model as { id?: string } | undefined;
        if (m?.id) this.model = m.id;
        break;
      }
      case 'session.step.ended': {
        const t = (data?.tokens ?? {}) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        this.tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
        break;
      }
      case 'session.reasoning.started':
        this.set({ state: 'thinking', activity: 'thinking' });
        break;
      case 'session.reasoning.ended': {
        const text = String(data?.text ?? '').replace(/\s+/g, ' ').trim();
        if (text) fm.agentLog(id, 'text', `~ ${truncate(text, 300)}`);
        break;
      }
      case 'session.text.ended': {
        const text = String(data?.text ?? '').trim();
        if (!text) break;
        fm.agentLog(id, 'text', truncate(text, 1200));
        this.finalText = text;
        this.set({ state: 'thinking', activity: firstLine(text, 48) });
        break;
      }
      case 'session.tool.input.started':
        this.calls.set(String(data?.id), { name: String(data?.name ?? '?'), input: {} });
        break;
      case 'session.tool.called': {
        const callId = String(data?.id);
        const name = String(this.calls.get(callId)?.name ?? data?.name ?? '?');
        const input = (data?.input ?? {}) as Record<string, unknown>;
        this.calls.set(callId, { name, input });
        const act = toolActivity(this.claudeName(name), input, this.cwd);
        fm.agentLog(id, 'tool', act.label);
        this.set({ state: act.state, station: act.station, activity: act.activity });
        if (/^(Write|Edit|MultiEdit)$/.test(this.claudeName(name))) this.refreshSoon();
        break;
      }
      case 'session.tool.success': {
        const callId = String(data?.id);
        const name = String(this.calls.get(callId)?.name ?? '?');
        this.calls.delete(callId);
        const text = (Array.isArray(data?.content) ? data.content : []).map((c: { text?: string }) => c.text ?? '').join('\n');
        const exit = (data?.metadata as { exit?: number } | undefined)?.exit;
        if (typeof exit === 'number' && exit !== 0) fm.agentLog(id, 'error', truncate(`exit ${exit}${text ? `\n${tailLines(text, 6, 700)}` : ''}`, 800));
        else if (data?.metadata?.status === 'failed') fm.agentLog(id, 'error', truncate(text || `${name} failed`, 600));
        else fm.agentLog(id, 'result', tailLines(text, 8, 900) || 'ok');
        break;
      }
      case 'session.tool.failed': {
        const callId = String(data?.id);
        this.calls.delete(callId);
        const text = String(data?.error ?? data?.message ?? 'tool error');
        fm.agentLog(id, 'error', truncate(text, 600));
        break;
      }
    }
  }

  /** End the turn: fill stats from the session.execution.* event. */
  finish(type: string, data: any): void {
    const ok = type === 'session.execution.succeeded';
    const interrupted = type === 'session.execution.interrupted';
    this.stats.subtype = ok ? 'success' : interrupted ? 'interrupted' : 'error_during_execution';
    this.stats.isError = !ok;
    this.stats.numTurns = this.steps;
    if (this.tokens) this.stats.tokens = this.tokens;
    if (this.finalText) this.stats.resultText = this.finalText;
    if (!ok) {
      const msg = String(data?.error?.message ?? data?.error ?? data?.message ?? (interrupted ? `interrupted${data?.reason ? `: ${data.reason}` : ''}` : 'turn failed'));
      this.stats.errors.push(msg);
      if (/auth|api key|credential|unauthor|401|login/i.test(msg)) this.stats.authFailed = firstLine(msg, 200);
    }
    const tokens = this.stats.tokens ? ` · ${Math.round(this.stats.tokens / 1000)}k tokens` : '';
    const label = ok ? `turn complete (${this.steps} steps${tokens})` : `turn ${interrupted ? 'interrupted' : 'failed'}: ${truncate(this.stats.errors[0] ?? 'error', 160)} (${this.steps} steps${tokens})`;
    this.fm.agentLog(this.agentId, ok ? 'result' : 'error', label);
  }
}

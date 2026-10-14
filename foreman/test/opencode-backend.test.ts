// Orchestration test for the OpenCode engine with a scripted fake `opencode serve`
// (fixtures/fake-opencode.mjs): the real engine, HTTP + SSE client, in-process MCP team tools,
// policy, permission prompts, worktrees, CI, reviews and merges, with a fake model. No network,
// no opencode install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenCodeEngine } from '../src/agents/opencode/engine.js';
import { TeamBackend } from '../src/agents/team.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'fixtures', 'fake-opencode.mjs');
const OUTSIDE = path.join(os.homedir(), 'agentcraft-opencode-test-outside.txt');

const scenario = {
  turns: [
    {
      role: 'lead',
      match: '^New goal',
      steps: [
        { cmd: 'git log --oneline -3' },
        { tool: 'write_memory', args: { title: 'Plan: --version flag', body: '- t1 --version (Kit)', scope: 'shared' } },
        { tool: 'create_task', args: { title: 'Add a --version flag', description: 'print the package version', assignee: 'kit' } },
        { tool: 'send_message', args: { to: 'all', text: 'Plan is up.' } },
        { say: 'Planned one task.' },
      ],
    },
    {
      role: 'worker',
      match: 'Your task: t1',
      steps: [
        { cmd: 'git status' },
        { write: { file: 'src/cli.ts', content: '\n// --version\n' } },
        { cmd: 'npm install left-pad' },
        { editOutside: OUTSIDE },
        { tool: 'update_task', args: { task_id: 't1', status: 'review', summary: 'Added --version.' } },
        { say: 'Done: --version prints the version.' },
      ],
    },
    { role: 'lead', match: '^Review request: t1', steps: [{ tool: 'request_merge', args: { task_id: 't1', summary: 'Adds --version.' } }, { say: 'Looks good.' }] },
    {
      role: 'worker',
      match: 'requested changes',
      steps: [
        { write: { file: 'src/cli.ts', content: '\n// tweak\n' } },
        { tool: 'update_task', args: { task_id: 't1', status: 'review', summary: 'Tweaked as asked.' } },
      ],
    },
  ],
};

type LogLine = {
  pid: number;
  config?: string;
  instructions?: string;
  playing?: string;
  role?: string;
  sessionID?: string;
  prompt?: string;
  action?: string;
  resources?: string[];
  decision?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};
const readLog = (file: string): LogLine[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : [];

let h: Harness;
let home: string;
let repoPath: string;
let logFile: string;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  const scenarioFile = path.join(home, 'scenario.json');
  logFile = path.join(home, 'opencode-log.jsonl');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  process.env.OPENCODE_FAKE_SCENARIO = scenarioFile;
  process.env.OPENCODE_FAKE_LOG = logFile;
  h = makeForeman(home, ['--backend', 'opencode', '--workers', 'kit', '--repo', repoPath]);
  const opencode = new OpenCodeEngine(h.fm, h.cfg.opencode, { bin: process.execPath, args: [FAKE] });
  await h.fm.start(new TeamBackend(h.fm, h.cfg.claude, { name: 'opencode', engines: { lead: opencode, worker: opencode } }));
});

afterAll(async () => {
  await h.fm.close();
  delete process.env.OPENCODE_FAKE_SCENARIO;
  delete process.env.OPENCODE_FAKE_LOG;
  rmrf(home);
  rmrf(path.dirname(repoPath));
  rmrf(OUTSIDE);
});

describe('opencode engine (fake server)', () => {
  it('checks the opencode login and shows the team', () => {
    expect(h.fm.status.backend).toBe('opencode');
    expect(h.fm.status.auth).toBe('ok');
    expect(h.fm.status.account).toBe('Fake Provider');
    expect(h.fm.status.message).toContain('OpenCode');
  });

  it('plans, works in a worktree through the policy, asks, reviews, revises and merges', async () => {
    const fm = h.fm;
    const goal = await fm.submitGoal('Add a --version flag');
    await until(() => fm.tasks.list().length === 1 && fm.goal(goal.id)!.status === 'active', 30_000);
    expect(fm.memory.list().some((m) => m.title === 'Plan: --version flag')).toBe(true);

    // Kit: `git status` passes the policy silently; `npm install` asks -> Deny; the edit outside
    // the worktree asks -> Deny
    await until(() => fm.decisions.open().some((d) => d.kind === 'permission'), 30_000);
    const perm = fm.decisions.open().find((d) => d.kind === 'permission')!;
    expect(perm.question).toBe('Kit wants to run Bash: npm install left-pad');
    await fm.answerDecision(perm.id, 'Deny');
    await until(() => fm.decisions.open().some((d) => d.kind === 'permission' && d.question.includes(OUTSIDE)), 30_000);
    await fm.answerDecision(fm.decisions.open().find((d) => d.kind === 'permission')!.id, 'Deny');

    // CI, the lead's review, a merge decision -> Request changes -> Kit revises in the same session
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    const m1 = fm.decisions.open().find((d) => d.kind === 'merge')!;
    await fm.answerDecision(m1.id, 'Request changes', 'Add a comment about the flag.');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1' && d.id !== m1.id), 60_000);
    const m2 = fm.decisions.open().find((d) => d.kind === 'merge')!;
    await fm.answerDecision(m2.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done', 30_000);
    const cli = fs.readFileSync(path.join(repoPath, 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain('// --version');
    expect(cli).toContain('// tweak');

    const log = readLog(logFile);
    // the inline config: edits and commands ask, native web/sub-agent/question tools are off
    const config = JSON.parse(log.find((l) => l.config)!.config!);
    expect(config.permission).toEqual({ edit: 'ask', bash: 'ask' });
    expect(config.tools).toEqual({ webfetch: false, websearch: false, question: false, task: false });

    // the worktree instructions (the lead is read-only; both get the OpenCode notes)
    expect(log.filter((l) => l.instructions).every((l) => l.instructions!.includes('Working in AgentCraft (OpenCode)'))).toBe(true);

    // policies: in-worktree reads/writes auto-allowed, the install and the outside edit denied
    const decisions = log.filter((l) => l.action);
    expect(decisions.find((l) => l.action === 'shell' && l.resources?.[0] === 'git log --oneline -3')!.decision).toBe('once');
    expect(decisions.find((l) => l.action === 'shell' && l.resources?.[0] === 'git status')!.decision).toBe('once');
    expect(decisions.find((l) => l.action === 'shell' && l.resources?.[0] === 'npm install left-pad')!.decision).toBe('reject');
    expect(decisions.find((l) => l.action === 'edit' && l.resources?.[0] === 'src/cli.ts')!.decision).toBe('once');
    expect(decisions.find((l) => l.action === 'edit' && l.resources?.[0] === OUTSIDE)!.decision).toBe('reject');
    expect(fs.existsSync(OUTSIDE)).toBe(false);

    // the team tools went through the real MCP server
    const tools = log.filter((l) => l.tool).map((l) => l.tool);
    for (const name of ['write_memory', 'create_task', 'send_message', 'update_task', 'request_merge']) expect(tools).toContain(name);
    expect(log.filter((l) => l.tool).every((l) => !l.isError)).toBe(true);

    // the revision resumed Kit's session; sessions are recorded as opencode sessions
    const revision = log.filter((l) => l.playing === 'requested changes');
    expect(revision.length).toBe(1);
    const kitSession = fm.store.data.sessions['kit:t1']!;
    expect(kitSession.engine).toBe('opencode');
    const workerTurns = log.filter((l) => l.role === 'worker' && l.sessionID);
    expect(workerTurns.length).toBeGreaterThanOrEqual(2);
    expect(new Set(workerTurns.map((l) => l.sessionID)).size).toBe(1);
    expect(kitSession.sessionId).toBe(workerTurns[0]!.sessionID);

    // the world: Kit's monitor shows the real commands and edits, and the denied install
    const kitLog = fm.store.logTail('kit').map((e) => `${e.kind}:${e.text}`);
    expect(kitLog).toContain('tool:$ git status');
    expect(kitLog).toContain('tool:Write src/cli.ts');
    expect(kitLog).toContain('tool:$ npm install left-pad');
    expect(kitLog).toContain('error:Alex denied: Bash: npm install left-pad');
    expect(kitLog.some((l) => /^result:turn complete \(\d+ steps/.test(l))).toBe(true);
    expect(fm.status.costUsd).toBeGreaterThan(0);
  }, 120_000);
});

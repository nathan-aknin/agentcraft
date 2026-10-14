// A scripted stand-in for `opencode serve` (tests). It speaks the HTTP + SSE API the engine uses,
// plays one scenario turn per prompt, and appends everything it receives/answers to $OPENCODE_FAKE_LOG
// (one JSON object per line). The team tools are called for real, against the engine's in-process MCP
// server (startTeamMcpServer), through the MCP client.
//
// Steps: { cmd, output? }            run a shell command (permission ask)
//        { write: { file, content } } edit inside the worktree (permission ask; the policy auto-allows)
//        { editOutside: path }        edit outside the worktree (permission ask -> denied)
//        { tool, args }               call an AgentCraft team tool (the in-process MCP server)
//        { say }                      final answer text
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (process.argv.includes('auth')) {
  // `opencode auth list` (the engine's auth probe): one stored provider
  process.stdout.write('Fake Provider  API key  stored\n');
  process.exit(0);
}

const scenario = JSON.parse(fs.readFileSync(process.env.OPENCODE_FAKE_SCENARIO, 'utf8'));
const logFile = process.env.OPENCODE_FAKE_LOG;
const log = (o) => logFile && fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...o })}\n`);
const expectedAuth = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
log({ config: process.env.OPENCODE_CONFIG_CONTENT });

// Sessions outlive one `opencode serve` process in real opencode (they live on disk), so the fake
// persists the durable part across processes: a resume turn's fresh server must still find them.
const stateFile = logFile && `${logFile}.sessions.json`;
const sessions = new Map(); // id -> { directory, cost, outcome, pending: Map, instructions }
if (stateFile && fs.existsSync(stateFile)) {
  for (const [id, s] of Object.entries(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) sessions.set(id, { ...s, pending: new Map() });
}
const persist = () => {
  if (!stateFile) return;
  const out = {};
  for (const [id, s] of sessions) out[id] = { directory: s.directory, cost: s.cost, outcome: s.outcome, instructions: s.instructions };
  fs.writeFileSync(stateFile, JSON.stringify(out));
};
const sse = new Set();
let nextId = 1;
const uid = (p) => `${p}_${process.pid}_${nextId++}`;
let mcp;
let mcpUrl;

async function connectMcp(url) {
  if (mcp) await mcp.close().catch(() => {});
  mcp = new Client({ name: 'fake-opencode', version: '0.1.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url)));
}

const emit = (sessionID, type, data = {}) => {
  const frame = JSON.stringify({ type, data: { sessionID, ...data } });
  for (const send of sse) send(frame);
};

function ask(sessionID, action, resources, messageID, callId, metadata) {
  return new Promise((resolve) => {
    const id = uid('per');
    sessions.get(sessionID).pending.set(id, (decision) => {
      log({ action, resources, decision, sessionID });
      resolve(decision !== 'reject' && decision !== 'deny');
    });
    emit(sessionID, 'permission.asked', {
      id,
      action,
      resources,
      save: action === 'shell' ? [`${resources[0]} *`] : ['*'],
      ...(metadata ? { metadata } : {}),
      source: { type: 'tool', messageID, id: callId },
    });
  });
}

async function turn(sessionID, text) {
  const session = sessions.get(sessionID);
  const instructions = session.instructions.agentcraft ?? '';
  const role = instructions.includes('read-only') ? 'lead' : 'worker';
  const cwd = session.directory;
  const t = scenario.turns.find((x) => (!x.role || x.role === role) && new RegExp(x.match).test(text)) ?? { steps: [] };
  log({ playing: t.match ?? '(none)', role, sessionID, prompt: text.slice(0, 100) });
  for (const s of t.steps) {
    const assistantMessageID = uid('msg');
    const callId = uid('call');
    emit(sessionID, 'session.step.started', { agent: 'build', model: { id: 'fake-model', providerID: 'fake' }, assistantMessageID, started: Date.now() });
    if (s.cmd) {
      emit(sessionID, 'session.tool.input.started', { assistantMessageID, id: callId, name: 'shell' });
      emit(sessionID, 'session.tool.input.ended', { assistantMessageID, id: callId, text: JSON.stringify({ command: s.cmd }) });
      emit(sessionID, 'session.tool.called', { assistantMessageID, id: callId, input: { command: s.cmd }, executed: false });
      const allow = await ask(sessionID, 'shell', [s.cmd], assistantMessageID, callId);
      if (allow) emit(sessionID, 'session.tool.success', { assistantMessageID, id: callId, content: [{ type: 'text', text: s.output ?? '' }], metadata: { status: 'completed', exit: 0, truncated: false }, executed: false });
      else emit(sessionID, 'session.tool.failed', { assistantMessageID, id: callId, error: 'The user rejected this command', executed: false });
    } else if (s.write) {
      const file = path.join(cwd, s.write.file);
      emit(sessionID, 'session.tool.input.started', { assistantMessageID, id: callId, name: 'write' });
      emit(sessionID, 'session.tool.input.ended', { assistantMessageID, id: callId, text: JSON.stringify({ path: s.write.file, content: s.write.content }) });
      emit(sessionID, 'session.tool.called', { assistantMessageID, id: callId, input: { path: s.write.file, content: s.write.content }, executed: false });
      const allow = await ask(sessionID, 'edit', [s.write.file], assistantMessageID, callId, { files: [{ file: s.write.file, status: 'added', additions: 1, deletions: 0 }] });
      if (allow) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, s.write.content);
        emit(sessionID, 'session.tool.success', { assistantMessageID, id: callId, content: [{ type: 'text', text: `Created file successfully: ${s.write.file}` }], metadata: { truncated: false }, executed: false });
      } else emit(sessionID, 'session.tool.failed', { assistantMessageID, id: callId, error: 'The user rejected this edit', executed: false });
    } else if (s.editOutside) {
      emit(sessionID, 'session.tool.input.started', { assistantMessageID, id: callId, name: 'write' });
      emit(sessionID, 'session.tool.input.ended', { assistantMessageID, id: callId, text: JSON.stringify({ path: s.editOutside, content: 'x' }) });
      emit(sessionID, 'session.tool.called', { assistantMessageID, id: callId, input: { path: s.editOutside, content: 'x' }, executed: false });
      const allow = await ask(sessionID, 'edit', [s.editOutside], assistantMessageID, callId, { files: [{ file: s.editOutside, status: 'added', additions: 1, deletions: 0 }] });
      if (allow) emit(sessionID, 'session.tool.success', { assistantMessageID, id: callId, content: [{ type: 'text', text: `Created file successfully: ${s.editOutside}` }], metadata: { truncated: false }, executed: false });
      else emit(sessionID, 'session.tool.failed', { assistantMessageID, id: callId, error: 'The user rejected this edit', executed: false });
    } else if (s.tool) {
      const name = `agentcraft_${s.tool}`;
      emit(sessionID, 'session.tool.input.started', { assistantMessageID, id: callId, name });
      emit(sessionID, 'session.tool.input.ended', { assistantMessageID, id: callId, text: JSON.stringify(s.args ?? {}) });
      emit(sessionID, 'session.tool.called', { assistantMessageID, id: callId, input: s.args ?? {}, executed: false });
      let r;
      try {
        r = await mcp.callTool({ name: s.tool, arguments: s.args ?? {} });
      } catch (e) {
        r = { isError: true, content: [{ type: 'text', text: String(e) }] };
      }
      const content = r.content ?? [];
      log({ tool: s.tool, args: s.args, isError: !!r.isError, result: content.map((c) => c.text ?? '').join('\n').slice(0, 160) });
      if (r.isError) emit(sessionID, 'session.tool.failed', { assistantMessageID, id: callId, error: content.map((c) => c.text ?? '').join('\n'), executed: false });
      else emit(sessionID, 'session.tool.success', { assistantMessageID, id: callId, content, metadata: { truncated: false }, executed: false });
    } else if (s.say) {
      emit(sessionID, 'session.text.ended', { assistantMessageID, text: s.say });
    }
    emit(sessionID, 'session.step.ended', { assistantMessageID, finish: 'tool-calls', tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } } });
  }
  session.cost = Math.round((session.cost + 0.25) * 100) / 100;
  session.outcome = 'succeeded';
  persist();
  emit(sessionID, 'session.execution.succeeded');
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== expectedAuth) {
    res.writeHead(401).end();
    return;
  }
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  const readBody = async () => {
    let b = '';
    for await (const c of req) b += c;
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  };
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  if (req.method === 'GET' && p === '/api/info') return json(200, { version: 'fake', pid: process.pid });
  if (req.method === 'GET' && p === '/api/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
    const send = (frame) => res.write(`data: ${frame}\n\n`);
    sse.add(send);
    req.on('close', () => sse.delete(send));
    return;
  }

  let m;
  if (req.method === 'PUT' && /^\/api\/experimental\/mcp\//.test(p)) {
    mcpUrl = (await readBody()).config?.url ?? mcpUrl;
    return json(204);
  }
  if (req.method === 'POST' && p.startsWith('/api/experimental/mcp/') && p.endsWith('/connect')) {
    await connectMcp(mcpUrl);
    return json(204);
  }
  if (req.method === 'POST' && p === '/api/session') {
    const body = await readBody();
    const id = uid('ses');
    sessions.set(id, { directory: body.location?.directory ?? process.cwd(), cost: 0, pending: new Map(), instructions: {} });
    persist();
    return json(200, { data: { id } });
  }
  if ((m = /^\/api\/session\/([^/]+)$/.exec(p)) && req.method === 'GET') {
    const s = sessions.get(m[1]);
    return s ? json(200, { data: { id: m[1], cost: s.cost, outcome: s.outcome } }) : json(404, { error: 'not found' });
  }
  if ((m = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
    const body = await readBody();
    sessions.get(m[1]).instructions[m[2]] = body.value;
    log({ instructions: body.value });
    persist();
    return json(204);
  }
  if ((m = /^\/api\/session\/([^/]+)\/prompt$/.exec(p)) && req.method === 'POST') {
    const body = await readBody();
    const sessionID = m[1];
    sessions.get(sessionID).outcome = undefined;
    json(200, { data: {} });
    setTimeout(() => void turn(sessionID, body.text ?? '').catch((e) => log({ turnError: String(e) })), 10);
    return;
  }
  if ((m = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(p)) && req.method === 'POST') {
    const body = await readBody();
    const s = sessions.get(m[1]);
    const resolve = s?.pending.get(m[2]);
    s?.pending.delete(m[2]);
    emit(m[1], 'permission.replied', { requestID: m[2], reply: body.decision });
    resolve?.(body.decision);
    return json(200, { data: {} });
  }
  if ((m = /^\/api\/session\/([^/]+)\/interrupt$/.exec(p)) && req.method === 'POST') {
    const s = sessions.get(m[1]);
    if (s) {
      s.outcome = 'interrupted';
      persist();
      emit(m[1], 'session.execution.interrupted', { reason: 'user' });
    }
    return json(200, { data: {} });
  }
  json(404, { error: `unhandled ${req.method} ${p}` });
});

server.listen(port, '127.0.0.1');

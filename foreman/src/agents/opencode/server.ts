// A minimal client for `opencode serve`: the HTTP + SSE API on a private loopback port. The engine
// spawns one server per turn (like Codex's app-server) and drives it over HTTP; events (tool calls,
// text, permissions, the turn's end) arrive on the /api/event SSE stream. The session is durable in
// opencode's own store, so a later turn resumes it in a fresh server.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

type Json = unknown;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface OpenCodeServerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** the basic-auth password for this server (OPENCODE_SERVER_PASSWORD) */
  password: string;
  /** inline config (OPENCODE_CONFIG_CONTENT): permissions, tools, model */
  config: string;
  /** arguments before the `serve` subcommand (tests: node with a fake server script in `args`) */
  args?: string[];
  onStderr?(text: string): void;
}

export class OpenCodeServer {
  readonly child: ChildProcess;
  private readonly password: string;
  private readonly base: string;
  private readonly stderrTail: string[] = [];
  /** settles when the process has exited */
  readonly exited: Promise<void>;

  constructor(bin: string, port: number, opts: OpenCodeServerOptions) {
    this.password = opts.password;
    this.base = `http://127.0.0.1:${port}/api`;
    // a .cmd/.bat shim (npm's global install on Windows) only runs through cmd.exe
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const args = [...(opts.args ?? []), 'serve', '--port', String(port)];
    const env = { ...opts.env, OPENCODE_SERVER_PASSWORD: opts.password, OPENCODE_CONFIG_CONTENT: opts.config };
    this.child = viaCmd
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${bin}" ${args.join(' ')}`], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(bin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const capture = (s: string) => {
      for (const line of s.split(/\r?\n/).filter((l) => l.trim())) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        opts.onStderr?.(line);
      }
    };
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', capture);
    this.child.stderr?.on('data', capture);
    this.exited = new Promise((resolve) => {
      this.child.once('error', () => resolve());
      this.child.once('exit', () => resolve());
    });
  }

  /** The last lines the server wrote (for error messages). */
  stderr(): string[] {
    return [...this.stderrTail];
  }

  private headers(): Record<string, string> {
    return { Authorization: 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64'), 'Content-Type': 'application/json' };
  }

  private async json<T = Json>(method: string, path: string, body?: Json, signal?: AbortSignal): Promise<T> {
    const r = await fetch(this.base + path, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), ...(signal ? { signal } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Wait until the server answers /info (it is listening). */
  async ready(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if ((await fetch(this.base + '/info', { headers: this.headers() })).ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`opencode serve did not start${this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(' | ')}` : ''}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Register the team tools as an MCP server and connect it (server: same name as the model sees). */
  async connectMcp(server: string, url: string): Promise<void> {
    await this.json('PUT', `/experimental/mcp/${server}`, { config: { type: 'remote', url, codemode: false } });
    await this.json('POST', `/experimental/mcp/${server}/connect`, {});
  }

  async createSession(cwd: string, title: string): Promise<string> {
    const r = await this.json<{ data: { id: string } }>('POST', '/session', { title, agent: 'build', location: { directory: cwd } });
    return r.data.id;
  }

  /** The session, or undefined if it no longer exists. */
  async getSession(id: string): Promise<{ cost?: number; outcome?: string } | undefined> {
    try {
      const r = await this.json<{ data: { cost?: number; outcome?: string } }>('GET', `/session/${id}`);
      return r.data;
    } catch {
      return undefined;
    }
  }

  /** The role/rules/worktree the model should follow this turn (an API instruction entry). */
  async setInstructions(id: string, value: string): Promise<void> {
    await this.json('PUT', `/experimental/session/${id}/instructions/entries/agentcraft`, { value });
  }

  async prompt(id: string, text: string): Promise<void> {
    await this.json('POST', `/session/${id}/prompt`, { text, delivery: 'steer' });
  }

  replyPermission(id: string, requestId: string, allow: boolean): Promise<void> {
    return this.json('POST', `/session/${id}/permission/${requestId}/reply`, { decision: allow ? 'once' : 'reject' });
  }

  interrupt(id: string): Promise<void> {
    return this.json('POST', `/session/${id}/interrupt?resume=false`, {});
  }

  /**
   * Read /api/event for this session, calling `handler` for each of its events until the signal
   * aborts. Handlers run one after another (a permission ask may wait for the user). `onOpen` fires
   * once the stream is established, so the caller can prompt afterwards without missing events.
   */
  async events(sessionId: string, signal: AbortSignal, handler: (type: string, data: Record<string, unknown>) => Promise<void> | void, onOpen?: () => void): Promise<void> {
    const res = await fetch(this.base + '/event', { headers: this.headers(), signal });
    if (!res.ok || !res.body) throw new Error(`event stream -> ${res.status}`);
    onOpen?.();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        let ev: { type?: string; data?: Record<string, unknown> };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.data?.sessionID !== sessionId) continue;
        if (ev.type) await handler(ev.type, ev.data);
      }
    }
  }

  /** End the process (the team also ends its whole process tree when a turn is stopped). */
  close(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

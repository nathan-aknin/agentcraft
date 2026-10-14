// The team tools (../tools.ts) as an in-process MCP server for opencode. opencode adds the team
// tools by URL (server.ts connectMcp), so the engine answers them in-process, with direct access to
// the Foreman and the same TurnHandle guards as every other engine.
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentTool } from '../tools.js';

/** The team MCP server's name; opencode exposes its tools to the model as `<name>_<tool>`. */
export const MCP_SERVER = 'agentcraft';

export interface TeamMcpHandle {
  url: string;
  close(): Promise<void>;
}

/** Serve the team tools as a stateless streamable-HTTP MCP endpoint on a loopback port. */
export async function startTeamMcpServer(name: string, tools: AgentTool[]): Promise<TeamMcpHandle> {
  const defs: Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.shape)) as Tool['inputSchema'],
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const mcp = new Server({ name, version: '0.1.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      const t = byName.get(r.params.name);
      if (!t) return { content: [{ type: 'text' as const, text: `Unknown tool ${r.params.name}` }], isError: true };
      const args = z.object(t.shape).safeParse(r.params.arguments ?? {});
      if (!args.success) {
        const why = args.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
        return { content: [{ type: 'text' as const, text: `Invalid arguments for ${t.name}: ${why}` }], isError: true };
      }
      const result = await t.handler(args.data);
      return { content: result.content.map((c) => ({ type: 'text' as const, text: c.text })), ...(result.isError ? { isError: true } : {}) };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

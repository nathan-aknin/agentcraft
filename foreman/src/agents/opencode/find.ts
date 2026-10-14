// Where is the opencode CLI? An explicit path (--opencode-path / AGENTCRAFT_OPENCODE_PATH), then
// `opencode` on PATH (npm i -g opencode-ai, Homebrew...).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function onPath(name: string): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
    const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Windows: prefer a real executable over npm's extension-less shell script
    return process.platform === 'win32' ? (hits.find((h) => /\.(exe|cmd|bat)$/i.test(h)) ?? hits[0]) : hits[0];
  } catch {
    return undefined;
  }
}

let cached: { key: string; bin: string | undefined } | undefined;

export function findOpenCode(explicit?: string): string | undefined {
  const key = explicit ?? '';
  if (cached?.key === key) return cached.bin;
  const bin = explicit ? (fs.existsSync(explicit) ? explicit : onPath(explicit)) : onPath('opencode');
  cached = { key, bin };
  return bin;
}

export const OPENCODE_NOT_FOUND =
  'OpenCode CLI not found. Install it (npm i -g opencode-ai), log in once (`opencode auth login`), or pass --opencode-path <path to opencode>.';

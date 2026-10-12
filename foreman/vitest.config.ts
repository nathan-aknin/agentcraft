import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // every backend test spawns real child processes (claude/codex/opencode fakes); running all
    // files at full parallelism starves them into timeouts on an 8-core machine
    maxWorkers: 3,
  },
});

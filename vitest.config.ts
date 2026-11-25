import { defineConfig } from "vitest/config";

// Only Kitchen's own unit tests: never fixtures, spikes, or agent worktrees under .claude/.
// Many tests spawn real git, node and kitchen processes; 30 s keeps them from timing out on a busy machine.
// ADR 0029 §4: a test never downloads the browser: a missing one fails to install instead.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 30_000, env: { KITCHEN_BROWSER_INSTALL: "exit 1" } } });

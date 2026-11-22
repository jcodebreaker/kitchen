import { defineConfig } from "vitest/config";

// Only Kitchen's own unit tests: never fixtures, spikes, or agent worktrees under .claude/.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });

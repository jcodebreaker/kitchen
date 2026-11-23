# A CLI owns the loop; agents run headless

> **Superseded by [ADR 0016](0016-kitchen-lite.md)** (Kitchen lite, 2026-11-22): what this records was removed. Kept as history.

Kitchen's pipeline is driven by a deterministic TypeScript CLI (`npx devkitchen`), not by a skill running inside one agent session as the zazencodes factory does. The CLI holds the stage machine and every state change, and starts each role headless (`claude -p` or `codex exec`) from one shared set of role prompts. We chose this so Claude Code and Codex behave the same, so a long run never fills one session's context, and so a lost session or closed laptop can be resumed from files. The `/kitchen` skill in each tool is a thin wrapper that calls the CLI.

**Considered Options:** a skill as the orchestrator inside one session (simpler, but ties Kitchen to one tool's subagent features and to one session's lifetime).

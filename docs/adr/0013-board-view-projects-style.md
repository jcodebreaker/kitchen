# Amendment to ADR 0009: a Projects-style Board view

**Status.** Accepted, 2026-11-22. The user approved `dashboard/mockups/board-apple.html`, an Apple-style redesign researched on Mobbin (Linear, Notion, incident.io, Plane, hilos and Apple's site). They had turned down the first, Projects-style mock-up (`board-projects.html`) as too cramped. **Where this document and the approved mock-up differ, the mock-up wins.** It has:
- borderless grey lanes with a one-line header (name, count, who), no coloured top bars or tinted headers;
- colour only where it means something: amber for Needs you, green for Ready and pass, red only on failures, shown as text;
- the San Francisco system font, roomy cards with soft shadows, and quiet `low`/`med`/`high` pills;
- empty lanes folded into a narrow rail.

The structure below still holds. The layout ideas come from super-board's public board demo (`diagrams/index.html`), MIT © 2026 Eric Tech. We copy the layout, not its code or any GitHub branding.

**What changes.** Only the **Board** view of the v4 dashboard (ADR 0009). List view, the job panel, the composer, steering, pause/stop, the token and 127.0.0.1-only all stay as they are.

1. **Columns by stage**, in Kitchen's own words: **Needs you first, on the left** (and first on a phone), then Intake · Build · Check (gate + verify) · Review · Ready · Done. Super-board calls its column Blocked 🙋 and puts it last; the user chose first. Ready means ready to merge. Done holds closed jobs until Kitchen learns about merges, which comes later.
   - Each lane is a borderless grey surface with a one-line header: its name, a count and who works there (the model kitchen.yaml runs, `engine`, `you`, `closed`). No coloured top bars or tinted headers.
   - An empty lane folds into a narrow rail; on a phone it is one quiet line.
2. **Roomy cards** with soft shadows, in the San Francisco system font (SF Mono for ids):
   - the job id (`#005`), the round when past the first, the time in this stage, and the title on up to three lines;
   - a pill row of quiet pills: risk (`low` / `med` / `high`, the job's real risk), proof (pass / fail / not proven, from this round's verdict), and the cost;
   - a two-line live activity line from the agent's own stream, e.g. `Edit src/cli/status.ts +12 −3`, `✓ 14 tests pass`, or `✗ C2 failed` in red text;
   - a message button that opens the panel with the composer.
   - A ready card gets a green ring; a needs-you card an amber one.
3. **Colour only where it means something**: neutral greys, amber only for Needs you, green for Ready and pass, red only for failures, as text. Light and dark.
4. **Interactions stay v4's.** Clicking a card opens the panel and the composer works from the card; J/K, ⌘K and Esc still work. The columns scroll sideways on narrow screens; at phone width they stack.

**Process.** First a clickable mock-up in `dashboard/mockups/board-projects.html`, with real kitchen-dog jobs and light, dark and 400px. The user approves it, and only then is it wired into the dashboard.

**Built** (2026-11-22, `feat/apple-board`). The Board in `dashboard/dashboard.html` is the approved mock-up's CSS and card structure on real data. Each job's lane, proof pill and risk come from the snapshot (`laneOf`, `proofOf`, `riskOf` in `src/dashboard/data.ts`): a job waiting for a Toolkit (ADR 0010) sits in Needs you with its Copy and Resume buttons, a job stopped by you or rejected sits in Done, and risk is intake's risk raised by the gate's floor. Each lane header names the model kitchen.yaml runs there. The whole page, List and panel too, now uses the system San Francisco stack, so it reads as one design; the bundled Geist fonts, their route and their NOTICE entry are gone.

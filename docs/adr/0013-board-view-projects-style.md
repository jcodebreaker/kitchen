# Amendment to ADR 0009: a Projects-style Board view

**Status.** Proposed, 2026-11-22. **Needs the user's approval: it changes the look of the approved v4 Board view.** The layout ideas come from super-board's public board demo (`diagrams/index.html`), MIT © 2026 Eric Tech. We copy the layout, not its code or any GitHub branding.

**What changes.** Only the **Board** view of the v4 dashboard (ADR 0009). List view, the job panel, the composer, steering, pause/stop, the token and 127.0.0.1-only all stay as they are.

1. **Columns by stage**, in Kitchen's own words: Intake · Build · Check (gate + verify) · Review · Ready · Done, plus a **Needs you** column at the end (super-board calls theirs Blocked 🙋).
   - Each column has a 3px top border in its stage colour, a lightly tinted header and a count.
   - A mono subtitle says who works there: `sonnet`, `engine`, `opus`, `you`.
2. **Compact cards** in a GitHub Projects-like style:
   - the job id in mono (`#005`) and the title on two lines at most;
   - a pill row: risk (low/medium/high), verdict (pass / fail / not proven), round (`r2`), and cost;
   - one live evidence line in mono, e.g. `build · Edit src/cli/status.ts`, or `✓ 14/14 tests`, or a red pill `✗ C2 failed`.
   - A merged-ready card gets a green border; a needs-you card an amber one.
3. **Neutral palette**: Primer-like greys with each stage colour used only in its column's border, header tint and pills, in light and dark. Base colours: white / `#0d1117`, soft `#f6f8fa` / `#151b23`, borders `#d1d9e0` / `#3d444d`. Stage colours use the same lightness in each theme. The v4 rule that orange means "needs you" still holds: the amber stays reserved for Needs you.
4. **Interactions stay v4's.** Clicking a card opens the panel and the composer works from the card; J/K, ⌘K and Esc still work. The columns scroll sideways on narrow screens; at phone width they stack.

**Process.** First a clickable mock-up in `dashboard/mockups/board-projects.html`, with real kitchen-dog jobs and light, dark and 400px. The user approves it, and only then is it wired into the dashboard.

# Use the browser that is already installed

**Status.** Accepted, 2026-11-25, by the user ("yes go ahead"). Amends ADR 0029 §4, where `kitchen run` and `kitchen init` install Playwright's Chromium (~150 MB) when it is missing.

## Why

QA drives pages with Playwright, and Kitchen launches only Playwright's own Chromium (`chromium.launch({ headless: true })`, `src/qa/app.ts`). Most machines already have Google Chrome or Microsoft Edge, and Playwright can drive them (`channel: "chrome"` / `"msedge"`). Tried on this machine, the installed Chrome 158 launched headless and took a screenshot in under a second. Kitchen downloads 150 MB without asking for something the machine already has, while ADR 0033 made every other heavy step opt-in.

## Decision

1. **Pick the browser in this order.** Google Chrome (`channel: "chrome"`), then Microsoft Edge (`"msedge"`), then Playwright's Chromium (including its headless shell), but only if it is already on disk. One helper resolves the choice, and `kitchen qa page`, `kitchen doctor` and the run preflight all use it. Playwright's Chromium is launched by its own binary: the full browser, or the headless shell's `chrome-headless-shell` when only that is there (the path doctor shows).
   - **A browser that doesn't start isn't the end.** Without a pin, `kitchen qa page` tries the next in the order and says which one didn't start, with up to five lines of why, and which one it used. When none starts, it refuses with each one's lines and "pin one with browser: in kitchen.yaml".
2. **Kitchen never downloads a browser.** `ensureBrowser` no longer installs anything.
   - When QA needs a browser (ADR 0029's `browserNeeded`) and none is found, `kitchen run` refuses with "QA needs a browser: install Google Chrome, or run `(cd <Kitchen's folder> && npx playwright install chromium)`", with the folder's real path: npx run there uses Kitchen's pinned Playwright, so it installs the Chromium Kitchen looks for (run elsewhere it may fetch another Playwright and another Chromium). `kitchen qa page` says the same line, and `kitchen doctor` gives the same fix. The command is POSIX shell syntax; on Windows `cmd` the person runs `cd` and `npx` as two commands (not handled).
   - When QA doesn't need one, it is a note.
   - `kitchen init` and `kitchen doctor` report which browser QA will use, or that none was found and how to get one. Neither installs.
3. **Say which browser tested it.** Each page capture's stamp (ADR 0031) records the browser and version, and the job's `tested` line (ADR 0032) names it ("Chrome 158"), set by the QA lane's first page capture; QA again on the same head and round (a true retry) keeps the last one named until a new capture sets it; any other QA start (a new head, a new round) names none until its first capture.
4. **`browser:` in kitchen.yaml** (`chrome | msedge | chromium`, optional) pins one browser. With a pin, the others are never tried, and a missing one is refused by name: "QA needs Edge (browser: msedge in kitchen.yaml): install Microsoft Edge, or take browser: out" (Chrome likewise; a pinned Chromium names the command above).

## Not chosen

- **Keep installing Chromium automatically:** it is a 150 MB download nobody asked for, when a browser is usually already there.
- **Chromium first, Chrome as a fallback:** a pinned engine gives more reproducible screenshots, but evidence is compared only within one run. The installed browser is the common case and costs nothing.

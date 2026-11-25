# Releasing devkitchen to npm

Publishing is outward-facing and can't be taken back (npm keeps a version number forever, even after an unpublish), so it is done by a person, by hand, with these steps. Nothing in Kitchen's scripts or CI publishes.

## Claim the name first

**Publish `devkitchen` before the plugin files reach `main`.** The plugin (`plugins/kitchen/`) tells Claude Code and Codex to run a package by its npm name. Whoever publishes `devkitchen` first owns that name; if the plugin were on `main` while the name was free, someone else could publish `devkitchen@0.1.0` and every person who installs the plugin would run their code. So: publish 0.1.0 (below), pin it, then merge.

The skill is safe even if that order slips: it runs `npx -y devkitchen@<version>` only when `npm view devkitchen@<version> dist.integrity` (5 s timeout, no retries) prints exactly the hash pinned in `plugins/kitchen/pin.json`, which `npm run plugin:sync -- --pin` writes from the tarball you published. With no pin (as on this branch now, `"integrity": null`), it never runs `npx`: it uses a `kitchen` on PATH or tells the person how to install it.

## Before the first release (once)

1. **The repository.** `package.json` names `jcodebreaker/kitchen` (`repository.url`, `homepage`, `bugs.url`), and so do the README's plugin lines (`/plugin marketplace add jcodebreaker/kitchen`). Create that public GitHub repository, or change all of them to the real one (`grep -rn jcodebreaker README.md package.json docs/RELEASE.md`), then `npm run plugin:sync`. Push `main`.
2. **The npm account.** `npm login` as the account that will own `devkitchen` (the name was free on 2026-11-22: `npm view devkitchen` → 404). Turn on two-factor auth for publishing: `npm profile enable-2fa auth-and-writes`.
3. **The license holder.** `LICENSE` says "Kitchen contributors"; change it if a person or company should hold the copyright.

## Checks before any release

```sh
git switch main && git pull --ff-only
git status --short                     # must print nothing
npm ci
npm run typecheck && npm run lint && npm test
npm run plugin:sync                    # the plugin files match package.json's version: must print "every file is current"
claude plugin validate .               # the marketplace and the plugin manifest (Claude Code's own check; installs nothing)
claude plugin validate plugins/kitchen
npm pack --dry-run                     # read the file list one last time: dist/*.js, roles/, skills/, hooks/*.py, dashboard/dashboard.html, README.md, LICENSE, NOTICE
```

## The first release (0.1.0)

`package.json` already says `0.1.0`, so there is no `npm version` step (npm refuses to "bump" to the version it already has) and no release commit (nothing changed):

```sh
npm publish --access public            # asks for the 2FA code; prepack rebuilds dist/ from a clean tsc
npm run plugin:sync -- --pin           # pins the tarball you just published: plugins/kitchen/pin.json and the plugin's SKILL.md
git commit -am "plugin: pin devkitchen 0.1.0"
git tag v0.1.0 && git push origin v0.1.0
```

Only now merge the branch with the plugin files into `main` (or push `main`).

## Later releases

```sh
npm version patch --no-git-tag-version # or minor; edits package.json and package-lock.json only
npm run plugin:sync                    # the manifests follow the new version; the old pin no longer counts (npx off)
git commit -am "release $(node -p 'require("./package.json").version')"
npm publish --access public
npm run plugin:sync -- --pin && git commit -am "plugin: pin devkitchen $(node -p 'require("./package.json").version')"
v=$(node -p 'require("./package.json").version'); git tag "v$v" && git push && git push origin "v$v"
```

Then check it from nowhere near the repo:

```sh
cd "$(mktemp -d)" && npx devkitchen@0.1.0 --version     # 0.1.0 (the version you published)
```

## What the package contains (and doesn't)

`package.json` `files` is an allowlist: the compiled `dist/**/*.js` (no source maps, no tests), the role prompts (`roles/`), the `/kitchen` skill (`skills/`), the guard hooks (`hooks/*.py`), the dashboard page, `README.md`, `LICENSE` and `NOTICE` (third-party notices: super-board's MIT notice for the hooks; Anthropic's for the vendored security review). Playwright is a pinned dependency (`playwright` 1.65.0); QA drives the installed Chrome or Edge with it, else its Chromium when already on disk (ADR 0034: Kitchen never downloads a browser; `(cd <Kitchen's folder> && npx playwright install chromium)` by hand, so npx runs the pinned Playwright). Fixtures, the benchmark data (`bench/`), `src/` and docs are not shipped. The tarball check that lived in spikes/w5 went with the spikes: read the `npm pack --dry-run` list by hand.

## If something is wrong after publishing

`npm deprecate devkitchen@0.1.0 "<why>"` and publish a fixed patch version. Unpublishing is allowed only within 72 hours and burns the version number.

## The Claude Code and Codex plugin

The plugin lives in this repository, not on npm: `.claude-plugin/marketplace.json` (Claude Code; Codex reads it too), `.agents/plugins/marketplace.json` (Codex's own), and `plugins/kitchen/` with a `.claude-plugin/plugin.json`, a `.codex-plugin/plugin.json` and the `/kitchen` skill. All of it is generated by `npm run plugin:sync` from `package.json`, `skills/kitchen/SKILL.md` and `plugins/kitchen/pin.json`; `src/plugin/sync.test.ts` fails when they drift. The skill runs `npx -y devkitchen@<version>` only for the pinned tarball (see "Claim the name first").

Plugin skills are namespaced by their plugin: in Claude Code the skill is **`/kitchen:kitchen`** (type `/kitchen` and pick it from the menu); in Codex it is `kitchen:kitchen` (in `/skills`, or `$kitchen:kitchen` in a message). A repo where `kitchen init` ran also has the plain `/kitchen` skill in `.claude/skills/` and `.agents/skills/`.

People get it once `main` is pushed, with nothing else to publish:

```
/plugin marketplace add jcodebreaker/kitchen      # Claude Code
/plugin install kitchen@kitchen

codex plugin marketplace add jcodebreaker/kitchen # Codex
codex plugin install kitchen@kitchen
```

Check it from a scratch folder after the release, in a throwaway session: `/plugin marketplace add jcodebreaker/kitchen`, `/plugin install kitchen@kitchen`, restart, then `/kitchen:kitchen set up Kitchen` in a test repo: it must run `npm view devkitchen@<version> dist.integrity …` first, see the pinned hash, and then use `npx -y devkitchen@<version>`. To tag a plugin release the way Claude Code's tooling expects: `claude plugin tag plugins/kitchen` (it checks that plugin.json and the marketplace entry agree), then push the tag. Listing it in Anthropic's or OpenAI's curated directories is a separate submission, not needed for the commands above.

# Releasing devkitchen to npm

Publishing is outward-facing and can't be taken back (npm keeps a version number forever, even after an unpublish), so it is done by a person, by hand, with these steps. Nothing in Kitchen's scripts or CI publishes.

## Before the first release (once)

1. **The repository.** Create the public GitHub repository and replace the `OWNER/kitchen` placeholders in `package.json` (`repository.url`, `homepage`, `bugs.url`). Push `main`.
2. **The npm account.** `npm login` as the account that will own `devkitchen` (the name was free on 2026-11-22: `npm view devkitchen` → 404). Turn on two-factor auth for publishing: `npm profile enable-2fa auth-and-writes`.
3. **The license holder.** `LICENSE` says "Kitchen contributors"; change it if a person or company should hold the copyright.

## Checks before any release

```sh
git switch main && git pull --ff-only
git status --short                     # must print nothing
npm ci
npm run typecheck && npm run lint && npm test
node spikes/w5/pack.ts                 # tarball contents, no secrets, npx and install smoke from a temp dir
npm pack --dry-run                     # read the file list one last time: dist/*.js, roles/, skills/, toolkit-template/, dashboard/dashboard.html, README.md, LICENSE, NOTICE
```

## The first release (0.1.0)

`package.json` already says `0.1.0`, so there is no `npm version` step (npm refuses to "bump" to the version it already has) and no release commit (nothing changed):

```sh
npm publish --access public            # asks for the 2FA code; prepack rebuilds dist/ from a clean tsc
git tag v0.1.0 && git push origin v0.1.0
```

## Later releases

```sh
npm version patch --no-git-tag-version # or minor; edits package.json and package-lock.json only
git commit -am "release $(node -p 'require("./package.json").version')"
npm publish --access public
v=$(node -p 'require("./package.json").version'); git tag "v$v" && git push && git push origin "v$v"
```

Then check it from nowhere near the repo:

```sh
cd "$(mktemp -d)" && npx devkitchen@0.1.0 --version     # 0.1.0 (the version you published)
```

## What the package contains (and doesn't)

`package.json` `files` is an allowlist: the compiled `dist/**/*.js` (no source maps, no tests), the role prompts (`roles/`), the `/kitchen` skill (`skills/`), the Toolkit template (`toolkit-template/`; npm drops its `.gitignore`, so `kitchen init` writes one), the dashboard page, `README.md`, `LICENSE` and `NOTICE` (third-party notices: pstack's MIT notice; zazencodes credited for ideas only). Fixtures, spikes, the benchmark (`bench/`, `kitchen bench` runs only from a clone), `src/` and docs are not shipped. `spikes/w5/pack.ts` asserts all of this and scans the unpacked tarball for secret-shaped strings.

## If something is wrong after publishing

`npm deprecate devkitchen@0.1.0 "<why>"` and publish a fixed patch version. Unpublishing is allowed only within 72 hours and burns the version number.

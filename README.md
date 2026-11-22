# Kitchen

Kitchen is an open-source software factory: it takes a ticket and hands back a
pull request proven by driving the real app, using a coding agent (Claude Code
or Codex) for the judgment and deterministic code for everything else. It is
being built in waves; the plan is `docs/PLAN.md`, the record of each wave is
`docs/BUILD-LOG.md`. A quick start comes with v0.1 (W5).

```sh
kitchen init                      # kitchen.yaml, the /kitchen skill, a proven Toolkit on the branch kitchen/setup
kitchen ticket "<what you want>"  # a prompt ticket
kitchen run --detach              # drain the queue in the background
kitchen status
kitchen toolkit check             # prove the Toolkit end to end
```

## Known limitations (v0.1)

- **Linux: the setup bridge runs unsandboxed.** `kitchen init`'s setup agent
  writes the Toolkit's `bin/dev`, and Kitchen runs it before anyone has
  reviewed it (through the setup bridge, and for init's own check of the
  `kitchen/setup` commit). On macOS those runs go through `sandbox-exec`,
  which keeps them away from your SSH keys, cloud and GitHub credentials,
  agent logins and Kitchen's own key. On Linux there is no sandbox yet: they
  run as you, and Kitchen logs `runs UNSANDBOXED` when they start. Review
  `kitchen/setup` before you merge it either way. Details and the residual
  risks on macOS: `docs/adr/0008-setup-bridge.md`.

## Credits

- The Toolkit's shape (Launch, Doctor, Drive, Evidence, Cleanup, the feature
  map) and the setup role (`roles/setup.md`) are ported from pstack's
  `create-verification-skill` and `maintain-verification-skill`, MIT License,
  Copyright (c) 2026 Lauren Tan.

## License

MIT

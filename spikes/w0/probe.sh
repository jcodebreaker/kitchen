#!/bin/sh
# Integrity probe. Run from inside an agent session, in the job worktree.
# Usage: sh probe.sh <jobs-dir> <bare-remote-path>
# Checks: a push/credentials, b gh, c job state, e detach, f docker, h network, g the worktree's .git.
# Prints one "key: exit=<n> | <first useful line>" per check and copies it to ./probe.out.
JOBS="$1"; BARE="$2"
out=./probe.out; : > "$out"
say() { echo "$1" | tee -a "$out"; }
check() { # key, command...
  key="$1"; shift
  res=$("$@" 2>&1); code=$?
  say "$key: exit=$code | $(printf '%s' "$res" | grep -v '^\s*$' | tail -1 | cut -c1-160)"
}

say "env: GH_TOKEN=${GH_TOKEN:+set} GITHUB_TOKEN=${GITHUB_TOKEN:+set} SSH_AUTH_SOCK=${SSH_AUTH_SOCK:+set} GIT_CONFIG_NOSYSTEM=$GIT_CONFIG_NOSYSTEM GIT_SSH_COMMAND=$GIT_SSH_COMMAND GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT GH_CONFIG_DIR=${GH_CONFIG_DIR:+set}"
check a-push-file  git push "$BARE" HEAD:refs/heads/agent-push
check a-push-ssh   git push git@github.com:kitchen-spike/none.git HEAD:refs/heads/x
check a-push-https git push https://github.com/kitchen-spike/none.git HEAD:refs/heads/x
say "a-helpers: [$(git config --get-all credential.helper | tr '\n' ',')]"
# never print a credential: only say whether one came back
cred=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>&1); code=$?
case "$cred" in *password=*) got=yes ;; *) got=no ;; esac
say "a-cred-fill: exit=$code | password-returned=$got | $(printf '%s' "$cred" | grep -v password | tail -1 | cut -c1-120)"
check b-gh        gh auth status
check c-jobs-write sh -c "echo forged > '$JOBS/001/job.json'"
check c-jobs-mkdir mkdir "$JOBS/002"
check e-detach    node ./detach.mjs "$JOBS"
check f-docker    docker version --format 'server {{.Server.Version}}'
# network: through any proxy the tool sets up, and direct to an IP (no DNS, no proxy)
check h-net-curl  curl -sS --max-time 5 -o /dev/null https://example.com
check h-net-nc    nc -z -w 3 1.1.1.1 443
# last, since it breaks git in the worktree if it succeeds: redirect the worktree to another gitdir
check g-git-write sh -c "printf 'gitdir: /tmp/kitchen-evil-shell\n' > .git"
say "probe: done"

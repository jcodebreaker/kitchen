#!/usr/bin/env python3
"""Kitchen guard (PreToolUse Bash): no push to the base branch or main.

On by default (ADR 0016 §5): Kitchen merges passing jobs into staging itself (kitchen job finish), and main and the
base branch change only by a person. Protected: main, master, kitchen.yaml's `staging.base`, and any name in
KITCHEN_PROTECTED_BRANCHES (comma-separated). A `git push` is denied when it would update or delete one of them:
an explicit refspec (`feat:main`, `+main`, `HEAD:refs/heads/main`, `--delete main`), `--all` / `--mirror`, or a
bare `git push` / `git push origin HEAD` while the protected branch is checked out. `gh pr merge` with
`--admin` is denied too. Force pushes to job branches stay allowed.

KITCHEN_ALLOW_PROTECTED_PUSH=1 in Claude Code's environment turns it off for a session (a person's own session).
Its own errors never block a tool call: anything unexpected exits 0 with no output.

Adapted from super-board's hooks/guard-protected-push.py (Eric Tech, MIT). See NOTICE.
"""
import json
import os
import re
import subprocess
import sys

GIT_VALUE_OPTS = {"-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
PUSH_VALUE_OPTS = {"--repo", "--receive-pack", "--exec", "-o", "--push-option", "--signed"}
FORCE = re.compile(r"^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$")


def segments(command):
    """Split a shell command into simple-command token lists. Quotes are honoured; nothing runs."""
    out, tokens, cur, has, quote = [], [], "", False, None
    i = 0

    def push_token():
        nonlocal cur, has
        if has:
            tokens.append(cur)
        cur, has = "", False

    while i < len(command):
        c = command[i]
        if quote:
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"' and i + 1 < len(command):
                i += 1
                cur += command[i]
            else:
                cur += c
        elif c in "'\"":
            quote, has = c, True
        elif c == "\\" and i + 1 < len(command):
            i += 1
            cur += command[i]
            has = True
        elif c in " \t":
            push_token()
        elif c in ";\n|&()":
            push_token()
            if tokens:
                out.append(tokens)
            tokens = []
        else:
            cur += c
            has = True
        i += 1
    push_token()
    if tokens:
        out.append(tokens)
    return out


def branch_name(ref):
    ref = ref.lstrip("+")
    return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref


def pushes(command, cwd):
    """[(git_dir, flags, positional)] for every `git push` in the command."""
    found, d = [], cwd
    for tokens in segments(command):
        while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
            tokens = tokens[1:]
        if tokens and tokens[0] in ("sudo", "command", "env"):
            tokens = tokens[1:]
        if not tokens:
            continue
        cmd, args = tokens[0], tokens[1:]
        if cmd == "cd" and args and "$" not in args[0]:
            d = os.path.normpath(os.path.join(d, os.path.expanduser(args[0])))
            continue
        if os.path.basename(cmd) != "git":
            continue
        git_dir, i = d, 0
        while i < len(args) and args[i].startswith("-"):
            if args[i] == "-C" and i + 1 < len(args):
                git_dir = os.path.normpath(os.path.join(git_dir, os.path.expanduser(args[i + 1])))
                i += 2
            elif args[i] in GIT_VALUE_OPTS:
                i += 2
            else:
                i += 1
        if i >= len(args) or args[i] != "push":
            continue
        flags, positional, j = [], [], i + 1
        while j < len(args):
            a = args[j]
            if a == "--":
                positional += args[j + 1:]
                break
            if a in PUSH_VALUE_OPTS:
                j += 1
            elif a.startswith("-"):
                flags.append(a)
            elif not re.match(r"^\d*[<>]", a):
                positional.append(a)
            j += 1
        found.append((git_dir, flags, positional))
    return found


def current_branch(d):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    try:
        r = subprocess.run(["git", "-C", d, "symbolic-ref", "--short", "-q", "HEAD"],
                           capture_output=True, text=True, env=env, timeout=10)
        return r.stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired):
        return None


def protected_branches(project_dir):
    """main, master, kitchen.yaml's staging.base (read with a plain scan: no YAML library), the env's list."""
    names = {"main", "master"}
    try:
        with open(os.path.join(project_dir, "kitchen.yaml")) as fh:
            text = fh.read()
        m = re.search(r"^staging:[ \t]*\{[^}]*\bbase:[ \t]*[\"']?([A-Za-z0-9._/-]+)", text, re.M) or re.search(
            r"^staging:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+base:[ \t]*[\"']?([A-Za-z0-9._/-]+)", text, re.M)
        if m:
            names.add(m.group(1))
    except OSError:
        pass
    names.update(n.strip() for n in os.environ.get("KITCHEN_PROTECTED_BRANCHES", "").split(",") if n.strip())
    return names


def check(command, cwd, protected, branch_of):
    """None when allowed, else the deny reason. branch_of(dir) -> checked-out branch or None."""
    if re.search(r"\bgh\s+pr\s+merge\b[^;&|]*--admin\b", command):
        return "Blocked by Kitchen: gh pr merge --admin skips the base branch's protections; a person does that."
    if not re.search(r"\bpush\b", command):
        return None
    for git_dir, flags, positional in pushes(command, cwd):
        force = any(FORCE.match(f) for f in flags) or any(p.startswith("+") for p in positional[1:])
        deleting = any(f in ("-d", "--delete") for f in flags)
        hit = None
        if "--all" in flags or "--mirror" in flags or "--branches" in flags:
            hit = "every branch (" + next(f for f in flags if f in ("--all", "--mirror", "--branches")) + ")"
        elif len(positional) <= 1:
            if not deleting and "--tags" not in flags:
                cur = branch_of(git_dir)
                if cur in protected:
                    hit = cur
        else:
            for spec in positional[1:]:
                dst = spec.split(":", 1)[1] if ":" in spec else spec
                if dst.lstrip("+") == "HEAD" or (":" not in spec and spec.lstrip("+") == "HEAD"):
                    dst = branch_of(git_dir) or dst
                name = branch_name(dst)
                if name in protected:
                    hit = name
                    break
        if hit:
            kind = "Force push" if force else ("Delete" if deleting else "Direct push")
            return (
                "Blocked by Kitchen: %s to protected branch %s.\n"
                "Kitchen never pushes to the base branch or main: passing jobs merge into staging through "
                "`kitchen job finish`, and a person merges staging onward. Protected here: %s. If this push really "
                "is intended, ask the user to run it." % (kind, hit, ", ".join(sorted(protected)))
            )
    return None


def main():
    try:
        if os.environ.get("KITCHEN_ALLOW_PROTECTED_PUSH") == "1":
            return
        payload = json.loads(sys.stdin.read() or "{}")
        command = (payload.get("tool_input") or {}).get("command")
        if not isinstance(command, str):
            return
        cwd = payload.get("cwd") or os.getcwd()
        project = os.environ.get("CLAUDE_PROJECT_DIR") or cwd
        reason = check(command, cwd, protected_branches(project), current_branch)
        if reason:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                     "permissionDecision": "deny",
                                                     "permissionDecisionReason": reason}}))
    except Exception:
        pass  # a broken guard must never block unrelated work


if __name__ == "__main__":
    main()

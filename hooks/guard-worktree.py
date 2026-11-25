#!/usr/bin/env python3
# kitchen-hooks-version: 2  (ADR 0030: kitchen run refreshes an older installed copy, never a newer one)
"""Kitchen guard (PreToolUse Bash|Edit|MultiEdit|Write|NotebookEdit): agents work inside their job's worktree.

1. `git worktree add|move` may only target <repo>/.worktrees/ (Kitchen's job worktrees), <repo>/.kitchen/merge/
   (staging's scratch merges) or <repo>/.claude/worktrees/ (Claude Code's own). Honours `cd X &&` and `git -C X`.
2. A lane agent (a subagent bound to a Kitchen job, see kitchen_jobs.py) may write files only inside its job's
   worktree, its job folder and the temp folders. The intake lane has no worktree: only its job folder. In the job
   folder, the files Kitchen owns (job.json, briefs, stamps, ...) are never its to write (ADR 0031; Edit/Write only).
3. A lane agent whose job the person removed (`kitchen remove`, job.json `archived`), or whose job ended while it
   worked (done or rejected with no lane open: its PR merged or closed on GitHub), is refused every call: it stops.

Its own errors never block a tool call: anything unexpected exits 0 with no output.

Adapted from super-board's hooks/guard-worktree-path.py (Eric Tech, MIT; itself ported from BookKeepingApp's
.claude/hooks/guard-worktree-path.js). See NOTICE.
"""
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True  # no __pycache__ beside the hooks in the person's repo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kitchen_jobs import bound_job  # noqa: E402

ALLOWED_DIRS = [".worktrees", os.path.join(".kitchen", "merge"), os.path.join(".claude", "worktrees")]
TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
ADD_VALUE_OPTS = {"-b", "-B", "--reason"}
GIT_VALUE_OPTS = {"-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}


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


def expand(word, env):
    """Expand ~, $VAR, ${VAR}. None when a variable is unknown or a substitution is present."""
    s = re.sub(r"^~(?=/|$)", lambda m: env.get("HOME", "~"), word)
    unknown = []

    def var(m):
        name = m.group(1) or m.group(2)
        if name not in env:
            unknown.append(name)
        return env.get(name, "")

    s = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", var, s)
    if unknown or "$(" in s or "`" in s:
        return None
    return s


def worktree_targets(command, cwd, env):
    """[(raw, git_dir, resolved_or_None)] for every worktree add/move target."""
    found, d = [], cwd
    for tokens in segments(command):
        while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
            tokens = tokens[1:]
        if not tokens:
            continue
        cmd, args = tokens[0], tokens[1:]
        if cmd == "cd":
            target = expand(args[0], env) if args else env.get("HOME")
            if target:
                d = os.path.normpath(os.path.join(d, target))
            continue
        if os.path.basename(cmd) != "git":
            continue
        git_dir, i = d, 0
        while i < len(args) and args[i].startswith("-"):
            if args[i] == "-C":
                target = expand(args[i + 1] if i + 1 < len(args) else "", env)
                if target:
                    git_dir = os.path.normpath(os.path.join(git_dir, target))
                i += 2
            elif args[i] in GIT_VALUE_OPTS:
                i += 2
            else:
                i += 1
        if i >= len(args) or args[i] != "worktree" or i + 1 >= len(args):
            continue
        sub = args[i + 1]
        if sub not in ("add", "move"):
            continue
        positional, j = [], i + 2
        while j < len(args):
            a = args[j]
            if a == "--":
                positional += args[j + 1:]
                break
            if a in ADD_VALUE_OPTS:
                j += 1
            elif not a.startswith("-") and not re.match(r"^\d*[<>]", a):
                positional.append(a)
            j += 1
        idx = 0 if sub == "add" else 1
        if len(positional) <= idx:
            continue
        raw = positional[idx]
        ex = expand(raw, env)
        found.append((raw, git_dir, None if ex is None else os.path.normpath(os.path.join(git_dir, ex))))
    return found


def repo_root(toplevel):
    """The main checkout's root, from it or any worktree under one of the allowed folders."""
    for d in ALLOWED_DIRS:
        at = toplevel.find(os.sep + d + os.sep)
        if at != -1:
            return toplevel[:at]
    return toplevel


def check(command, cwd, root_of, env):
    """None when allowed, else the deny reason. root_of(dir) -> repo root or None."""
    if not re.search(r"\bworktree\b", command):
        return None
    for raw, git_dir, resolved in worktree_targets(command, cwd, env):
        repo = root_of(git_dir) or root_of(cwd)
        if not repo:
            continue  # not a repository: git itself will refuse
        allowed = [os.path.join(repo, d) for d in ALLOWED_DIRS]
        if resolved and any(resolved.startswith(a + os.sep) for a in allowed):
            continue
        where = ("resolves to " + resolved) if resolved else "cannot be resolved before it runs"
        return (
            'Blocked by Kitchen: worktree path "%s" %s, outside %s/.\n'
            "Kitchen makes each job's worktree itself (kitchen job start); you work in the one your brief names."
            % (raw, where, "/, ".join(allowed))
        )
    return None


def toplevel_of(d):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    try:
        r = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], capture_output=True,
                           text=True, env=env, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def under(p, root):
    return p == root or p.startswith(root.rstrip(os.sep) + os.sep)


# ADR 0031: the job folder's files Kitchen owns (its state, the brief it wrote, the stamps it took). Edit/Write only:
# Bash is not covered, so readQa's own checks (carried rows, stamps, the verdict's hash) are the real protection.
KITCHEN_FILES = {"job.json": "the job's state", "job.lock": "the job's lock", "control.json": "the steering file",
                 "messages.jsonl": "the person's messages", "clarifications.json": "the clarifications",
                 "ticket.md": "the ticket", "report.html": "the Report", "refused.txt": "Kitchen's refusal",
                 "app.json": "the running app's state"}


def kitchen_owned(rel, lane):
    """What Kitchen-owned file `rel` (relative to the job folder) is, or None when a lane agent may write it."""
    parts = rel.split(os.sep)
    name = parts[-1]
    if len(parts) == 1 and (name in KITCHEN_FILES or name.startswith("job.json")):
        return KITCHEN_FILES.get(name, "the job's state")
    if name.endswith(".meta.json"):
        return "a capture's stamp (kitchen qa writes it)"
    if parts[0] == "rounds" and len(parts) >= 3:
        if name.startswith("brief-") or name == "checks.json":
            return "the lane's brief" if name.startswith("brief-") else "the checks Kitchen ran"
        if len(parts) == 4 and parts[2] == "qa" and name == "criteria.json":
            return "the criteria QA was given"
        # ADR 0031 §5: the second look reads QA's folder; it never writes there.
        if lane == "second-look" and parts[2] == "qa":
            return "QA's folder (the second look only reads it)"
    return None


def write_check(payload):
    """None when a lane agent's file write is inside its job's places, else the deny reason."""
    path = (payload.get("tool_input") or {}).get("file_path") or (payload.get("tool_input") or {}).get("notebook_path")
    if not isinstance(path, str) or not path:
        return None
    repo = os.path.normpath(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd())
    job_id, job = bound_job(payload, repo)
    if not job_id:
        return None
    target = os.path.normpath(os.path.join(payload.get("cwd") or repo, os.path.expanduser(path)))
    places = [os.path.join(repo, ".kitchen", "jobs", job_id)]
    lane = (job.get("running") or {}).get("lane")
    if lane != "intake":
        places.append(job.get("worktree") or os.path.join(repo, ".worktrees", job_id))
    temps = TEMP_ROOTS + ([os.path.normpath(os.environ["TMPDIR"])] if os.environ.get("TMPDIR") else [])
    real = os.path.join(os.path.realpath(os.path.dirname(target)), os.path.basename(target))
    job_dir = places[0]
    for t in (target, real):
        for d in (job_dir, os.path.realpath(job_dir)):
            if under(t, d) and t != d:
                why = kitchen_owned(os.path.relpath(t, d), lane)
                if why:
                    return "Blocked by Kitchen: %s is %s: Kitchen writes it, never a lane agent." % (target, why)
    if any(under(t, p) for t in (target, real) for p in places):
        return None
    # A temp folder is fine, unless the repo itself lives in one (a scratch clone): its main checkout stays off limits.
    in_repo = any(under(t, r) for t in (target, real) for r in (repo, os.path.realpath(repo)))
    if not in_repo and any(under(t, p) for t in (target, real) for p in temps):
        return None
    return (
        "Blocked by Kitchen: %s is outside job %s's places (%s). A lane agent writes only in its worktree and its "
        "job folder; the main checkout and other jobs are not yours to change." % (target, job_id, ", ".join(places))
    )


def removed_check(payload):
    """The deny reason when this lane agent's job was removed by the person (`kitchen remove`) or ended while its
    lane ran (its PR merged or closed on GitHub, ADR 0026), else None."""
    repo = os.path.normpath(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd())
    job_id, job = bound_job(payload, repo)
    if not (job_id and job):
        return None
    if job.get("archived"):
        return ("Stopped by Kitchen: the person removed job %s. Stop now: make no more changes and reply with one line, "
                "\"removed\"." % job_id)
    if job.get("stage") in ("done", "rejected") and not job.get("running"):
        return ("Stopped by Kitchen: job %s ended while you worked (%s). Stop now: make no more changes and reply with "
                "one line, \"ended\"." % (job_id, "merged" if job.get("stage") == "done" else "rejected"))
    return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        gone = removed_check(payload)
        if gone:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                     "permissionDecision": "deny",
                                                     "permissionDecisionReason": gone}}))
            return
        if payload.get("tool_name") in ("Edit", "MultiEdit", "Write", "NotebookEdit"):
            reason = write_check(payload)
            if reason:
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                         "permissionDecision": "deny",
                                                         "permissionDecisionReason": reason}}))
            return
        command = (payload.get("tool_input") or {}).get("command")
        if not isinstance(command, str):
            return
        cwd = payload.get("cwd") or os.getcwd()

        def root_of(d):
            top = toplevel_of(d) or (os.environ.get("CLAUDE_PROJECT_DIR") if d == cwd else None)
            return repo_root(top) if top else None

        reason = check(command, cwd, root_of, dict(os.environ))
        if reason:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                     "permissionDecision": "deny",
                                                     "permissionDecisionReason": reason}}))
    except Exception:
        pass  # a broken guard must never block unrelated work


if __name__ == "__main__":
    main()

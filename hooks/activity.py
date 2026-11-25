#!/usr/bin/env python3
# kitchen-hooks-version: 2  (ADR 0030: kitchen run refreshes an older installed copy, never a newer one)
"""Kitchen hook (PreToolUse and PostToolUse, every tool): a lane agent's live activity for the dashboard.

Each tool call a lane agent makes (a subagent bound to a Kitchen job, see kitchen_jobs.py) is appended to the
stream of the lane `kitchen job start` opened (`running.stream` in the job's job.json), in the same message shapes
Claude Code's stream-json uses, so the dashboard's Activity tab reads it like any agent transcript. It never blocks
and prints nothing: a broken hook must never stop the work. Large inputs are cut; secrets are not its business
(guard-secrets keeps them out of the transcript in the first place).
"""
import datetime
import json
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ beside the hooks in the person's repo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kitchen_jobs import bound_job, lane_session, project_dir  # noqa: E402

CAP = 20000


def cut(v):
    if isinstance(v, str):
        return v if len(v) <= CAP else v[:CAP] + "…"
    if isinstance(v, dict):
        return {k: cut(x) for k, x in v.items()}
    if isinstance(v, list):
        return [cut(x) for x in v[:200]]
    return v


def short(resp):
    if isinstance(resp, str):
        return resp[:400]
    if isinstance(resp, dict):
        for k in ("stdout", "output", "content", "result", "message"):
            if isinstance(resp.get(k), str):
                return resp[k][:400]
        return json.dumps(resp)[:400]
    return json.dumps(resp)[:400] if resp is not None else ""


def main():
    try:
        # ADR 0030: a lane session `kitchen run` started: Kitchen writes its whole stream there itself.
        if lane_session():
            return
        payload = json.loads(sys.stdin.read() or "{}")
        repo = project_dir(payload)
        job_id, job = bound_job(payload, repo)
        if not job_id or not (job.get("running") or {}).get("stream"):
            return
        stream = os.path.join(repo, ".kitchen", "jobs", job_id, job["running"]["stream"])
        if not os.path.isfile(stream):
            return
        now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        tid = payload.get("tool_use_id") or ""
        if payload.get("hook_event_name") == "PreToolUse":
            line = {"type": "assistant", "timestamp": now, "message": {"content": [
                {"type": "tool_use", "id": tid, "name": payload.get("tool_name") or "?", "input": cut(payload.get("tool_input") or {})}]}}
        elif payload.get("hook_event_name") == "PostToolUse":
            resp = payload.get("tool_response")
            err = isinstance(resp, dict) and (resp.get("is_error") is True or resp.get("interrupted") is True)
            line = {"type": "user", "timestamp": now, "message": {"content": [
                {"type": "tool_result", "tool_use_id": tid, "is_error": bool(err), "content": short(resp)}]}}
        else:
            return
        with open(stream, "a") as fh:
            fh.write(json.dumps(line) + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    main()

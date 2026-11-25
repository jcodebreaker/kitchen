# kitchen-hooks-version: 2  (ADR 0030: kitchen run refreshes an older installed copy, never a newer one)
"""Which Kitchen job a lane agent works on, for Kitchen's hooks (guard-worktree.py, activity.py).

The orchestrator starts each lane agent with `kitchen job start`, which records the lane in the job's job.json
(`running`). A lane agent's first steps name its job: `cd <repo>/.worktrees/<id>` and a read of its brief under
`<repo>/.kitchen/jobs/<id>/`. When a tool call made inside a subagent (the hook input carries `agent_id`) names a
job whose lane is open, the agent is bound to that job in `.kitchen/agents/<agent_id>`; later calls of the same
agent are found from there. A lane session `kitchen run` started (ADR 0030) is a top-level session with no `agent_id`:
its environment names its job (KITCHEN_JOB). Python 3 standard library only.
"""
import json
import os
import re

JOB = re.compile(r"/(?:\.worktrees|\.kitchen/jobs)/(\d{3,}-[a-z0-9-]{1,48})(?:/|\b)")


def project_dir(payload):
    return os.path.normpath(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd())


def _job_json(repo, job_id):
    try:
        with open(os.path.join(repo, ".kitchen", "jobs", job_id, "job.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _mentions(payload):
    ti = payload.get("tool_input") or {}
    parts = [payload.get("cwd") or ""]
    for k in ("command", "file_path", "path", "notebook_path"):
        v = ti.get(k)
        if isinstance(v, str):
            parts.append(v)
    return "\n".join(parts)


def lane_session():
    """The job a lane session `kitchen run` started works on (ADR 0030: KITCHEN_JOB in its environment), or None."""
    job_id = os.environ.get("KITCHEN_JOB") or ""
    return job_id if re.match(r"^\d{3,}-[a-z0-9-]{1,48}$", job_id) else None


def bound_job(payload, repo=None):
    """(job_id, job_json) the lane agent behind this call works on, or (None, None). Binds a subagent on first sight."""
    own = lane_session()
    if own:
        job = _job_json(repo or project_dir(payload), own)
        return (own, job) if job else (None, None)
    agent = payload.get("agent_id")
    if not isinstance(agent, str) or not re.match(r"^[A-Za-z0-9_.-]{1,128}$", agent):
        return None, None
    repo = repo or project_dir(payload)
    agents = os.path.join(repo, ".kitchen", "agents")
    bind = os.path.join(agents, agent)
    try:
        with open(bind) as fh:
            job_id = fh.read().strip()
        job = _job_json(repo, job_id)
        return (job_id, job) if job else (None, None)
    except OSError:
        pass
    m = JOB.search(_mentions(payload))
    if not m:
        return None, None
    job_id = m.group(1)
    job = _job_json(repo, job_id)
    if not job or not job.get("running"):
        return None, None
    try:
        os.makedirs(agents, exist_ok=True)
        with open(bind, "w") as fh:
            fh.write(job_id)
    except OSError:
        pass
    return job_id, job

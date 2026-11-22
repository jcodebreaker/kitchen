"""Task queries. Every function takes an open connection and returns plain dicts."""

import sqlite3
from datetime import date


class TaskError(Exception):
    """A user-facing error (bad id, bad date, ...)."""


def parse_due(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise TaskError(f"invalid date {value!r}, expected YYYY-MM-DD") from None


def _rows(conn: sqlite3.Connection, where: str = "", args: tuple = ()) -> list[dict]:
    sql = f"""
      SELECT t.id, t.title, t.due, t.done, t.created_at,
             COALESCE(group_concat(tt.tag, ','), '') AS tags
      FROM tasks t LEFT JOIN task_tags tt ON tt.task_id = t.id
      {where} GROUP BY t.id ORDER BY t.done, COALESCE(t.due, '9999-12-31'), t.id"""
    return [{**dict(r), "done": bool(r["done"]), "tags": sorted(filter(None, r["tags"].split(",")))} for r in conn.execute(sql, args)]


def add(conn, title: str, due: str | None = None, tags: list[str] | None = None) -> dict:
    title = title.strip()
    if not title:
        raise TaskError("title must not be empty")
    due = parse_due(due)
    cur = conn.execute("INSERT INTO tasks (title, due) VALUES (?, ?)", (title, due))
    for tag in {t.strip().lower() for t in tags or [] if t.strip()}:
        conn.execute("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)", (cur.lastrowid, tag))
    conn.commit()
    return get(conn, cur.lastrowid)


def get(conn, task_id: int) -> dict:
    rows = _rows(conn, "WHERE t.id = ?", (task_id,))
    if not rows:
        raise TaskError(f"no task with id {task_id}")
    return rows[0]


def list_tasks(conn, tag: str | None = None, include_done: bool = False) -> list[dict]:
    clauses, args = [], []
    if not include_done:
        clauses.append("t.done = 0")
    if tag:
        clauses.append("t.id IN (SELECT task_id FROM task_tags WHERE tag = ?)")
        args.append(tag.strip().lower())
    return _rows(conn, "WHERE " + " AND ".join(clauses) if clauses else "", tuple(args))


def mark_done(conn, task_id: int) -> dict:
    get(conn, task_id)
    conn.execute("UPDATE tasks SET done = 1 WHERE id = ?", (task_id,))
    conn.commit()
    return get(conn, task_id)


def edit(conn, task_id: int, title: str | None = None, due: str | None = None) -> dict:
    get(conn, task_id)
    if title is not None:
        if not title.strip():
            raise TaskError("title must not be empty")
        conn.execute("UPDATE tasks SET title = ? WHERE id = ?", (title.strip(), task_id))
    if due is not None:
        conn.execute("UPDATE tasks SET due = ? WHERE id = ?", (parse_due(due), task_id))
    conn.commit()
    return get(conn, task_id)


def search(conn, text: str) -> list[dict]:
    return _rows(conn, "WHERE t.title LIKE ? COLLATE NOCASE", (f"%{text}%",))


def stats(conn) -> dict:
    today = date.today().isoformat()
    total, done, overdue = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(done), 0), COALESCE(SUM(done = 0 AND due < ?), 0) FROM tasks", (today,)
    ).fetchone()
    return {"total": total, "done": done, "open": total - done, "overdue": overdue}


def count_done(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM tasks WHERE done = 1").fetchone()[0]


def purge(conn) -> int:
    cur = conn.execute("DELETE FROM tasks WHERE done = 1")
    conn.commit()
    return cur.rowcount

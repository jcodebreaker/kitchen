"""SQLite connection and migrations."""

import os
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
DEFAULT_DB = "~/.local/share/tasks/tasks.db"


def db_path() -> Path:
    return Path(os.environ.get("TASKS_DB") or DEFAULT_DB).expanduser()


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Apply pending migrations in filename order; return the names applied."""
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))")
    done = {r[0] for r in conn.execute("SELECT name FROM schema_version")}
    applied = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.name in done:
            continue
        conn.executescript(f.read_text())
        conn.execute("INSERT INTO schema_version (name) VALUES (?)", (f.name,))
        conn.commit()
        applied.append(f.name)
    return applied


def connect() -> sqlite3.Connection:
    """Open the database (creating it and applying migrations if needed)."""
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn

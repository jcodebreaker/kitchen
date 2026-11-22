"""Command-line interface: `python3 -m tasks <command>`."""

import argparse
import csv
import json
import sys

from tasks import db, store
from tasks.store import TaskError

CSV_FIELDS = ["id", "title", "due", "done", "tags"]


def fmt(t: dict) -> str:
    mark = "x" if t["done"] else " "
    due = f" (due {t['due']})" if t["due"] else ""
    tags = "".join(f" #{g}" for g in t["tags"])
    return f"[{mark}] {t['id']:>3}  {t['title']}{due}{tags}"


def emit(args, data, human: str) -> None:
    print(json.dumps(data, indent=2) if args.json else human)


def emit_list(args, rows: list[dict]) -> None:
    emit(args, rows, "\n".join(map(fmt, rows)) if rows else "No tasks.")


def cmd_init(args, conn):
    emit(args, {"db": str(db.db_path()), "ok": True}, f"Database ready at {db.db_path()}")


def cmd_add(args, conn):
    t = store.add(conn, args.title, args.due, args.tag)
    emit(args, t, f"Added task {t['id']}: {t['title']}")


def cmd_list(args, conn):
    emit_list(args, store.list_tasks(conn, args.tag, args.all))


def cmd_done(args, conn):
    t = store.mark_done(conn, args.id)
    emit(args, t, f"Done: {t['id']} {t['title']}")


def cmd_edit(args, conn):
    if args.title is None and args.due is None:
        raise TaskError("nothing to edit: pass --title and/or --due")
    t = store.edit(conn, args.id, args.title, args.due)
    emit(args, t, f"Updated task {t['id']}: {t['title']}")


def cmd_search(args, conn):
    emit_list(args, store.search(conn, args.text))


def cmd_stats(args, conn):
    s = store.stats(conn)
    emit(args, s, f"{s['total']} tasks: {s['open']} open, {s['done']} done, {s['overdue']} overdue")


def cmd_purge(args, conn):
    n = store.count_done(conn)
    if not args.yes:
        print(f"Delete {n} done tasks? [y/N] ", end="", flush=True)
        if sys.stdin.readline().strip().lower() not in ("y", "yes"):
            raise TaskError("aborted")
    store.purge(conn)
    emit(args, {"deleted": n}, f"Deleted {n} done tasks")


def cmd_export(args, conn):
    rows = store.list_tasks(conn, include_done=True)
    out = open(args.out, "w", newline="") if args.out else sys.stdout
    try:
        if args.format == "json":
            json.dump(rows, out, indent=2)
            out.write("\n")
        else:
            w = csv.DictWriter(out, CSV_FIELDS, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({**r, "done": int(r["done"]), "tags": ";".join(r["tags"])})
    finally:
        if args.out:
            out.close()
    if args.out:
        emit(args, {"exported": len(rows), "out": args.out}, f"Exported {len(rows)} tasks to {args.out}")


def cmd_import(args, conn):
    try:
        f = open(args.file, newline="")
    except OSError as e:
        raise TaskError(f"cannot read {args.file}: {e.strerror}") from None
    n = 0
    with f:
        for row in csv.DictReader(f):
            tags = [g for g in (row.get("tags") or "").split(";") if g]
            t = store.add(conn, row.get("title", ""), row.get("due") or None, tags)
            if row.get("done") in ("1", "true", "yes"):
                store.mark_done(conn, t["id"])
            n += 1
    emit(args, {"imported": n}, f"Imported {n} tasks")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tasks", description="A small task tracker.")
    sub = p.add_subparsers(dest="cmd", required=True)

    def command(name, fn, help):
        sp = sub.add_parser(name, help=help)
        sp.add_argument("--json", action="store_true", help="machine-readable output")
        sp.set_defaults(fn=fn)
        return sp

    command("init", cmd_init, "create the database and apply migrations")
    sp = command("add", cmd_add, "add a task")
    sp.add_argument("title")
    sp.add_argument("--due", metavar="YYYY-MM-DD")
    sp.add_argument("--tag", action="append", default=[])
    sp = command("list", cmd_list, "list open tasks")
    sp.add_argument("--tag")
    sp.add_argument("--all", action="store_true", help="include done tasks")
    sp = command("done", cmd_done, "mark a task done")
    sp.add_argument("id", type=int)
    sp = command("edit", cmd_edit, "change a task")
    sp.add_argument("id", type=int)
    sp.add_argument("--title")
    sp.add_argument("--due", metavar="YYYY-MM-DD")
    sp = command("search", cmd_search, "find tasks by title")
    sp.add_argument("text")
    command("stats", cmd_stats, "show counts")
    sp = command("purge", cmd_purge, "delete done tasks")
    sp.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    sp = command("export", cmd_export, "export all tasks")
    sp.add_argument("--format", choices=["csv", "json"], default="json")
    sp.add_argument("--out", metavar="FILE")
    sp = command("import", cmd_import, "import tasks from a CSV file")
    sp.add_argument("file")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        conn = db.connect()
        try:
            args.fn(args, conn)
        finally:
            conn.close()
    except TaskError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0

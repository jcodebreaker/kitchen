import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "TASKS_DB": str(Path(self.tmp.name) / "t.db")}

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, stdin="", expect=0):
        p = subprocess.run([sys.executable, "-m", "tasks", *args], cwd=ROOT, env=self.env, input=stdin, capture_output=True, text=True)
        self.assertEqual(p.returncode, expect, p.stderr or p.stdout)
        return p

    def j(self, *args, **kw):
        return json.loads(self.run_cli(*args, "--json", **kw).stdout)

    def test_add_list_done(self):
        t = self.j("add", "Buy milk", "--due", "2030-05-01", "--tag", "home", "--tag", "shop")
        self.assertEqual((t["id"], t["tags"]), (1, ["home", "shop"]))
        self.assertEqual(len(self.j("list")), 1)
        self.run_cli("done", "1")
        self.assertEqual(self.j("list"), [])
        self.assertEqual(len(self.j("list", "--all")), 1)

    def test_tag_filter_and_search(self):
        self.run_cli("add", "Write docs", "--tag", "docs")
        self.run_cli("add", "Fix bug")
        self.assertEqual([t["title"] for t in self.j("list", "--tag", "docs")], ["Write docs"])
        self.assertEqual([t["title"] for t in self.j("search", "BUG")], ["Fix bug"])

    def test_edit_and_errors(self):
        self.run_cli("add", "Old")
        self.assertEqual(self.j("edit", "1", "--title", "New")["title"], "New")
        self.assertIn("no task with id 9", self.run_cli("done", "9", expect=1).stderr)
        self.assertIn("invalid date", self.run_cli("add", "x", "--due", "tomorrow", expect=1).stderr)

    def test_purge_confirmation(self):
        self.run_cli("add", "a")
        self.run_cli("done", "1")
        p = self.run_cli("purge", stdin="n\n", expect=1)
        self.assertIn("Delete 1 done tasks? [y/N]", p.stdout)
        self.assertEqual(self.j("stats")["total"], 1)
        self.run_cli("purge", stdin="y\n")
        self.assertEqual(self.j("stats")["total"], 0)

    def test_import_export_roundtrip(self):
        self.assertIn("Imported 6", self.run_cli("import", "seed/demo.csv").stdout)
        stats = self.j("stats")
        self.assertEqual((stats["total"], stats["done"]), (6, 2))
        self.assertGreaterEqual(stats["overdue"], 1)
        out = Path(self.tmp.name) / "out.csv"
        self.run_cli("export", "--format", "csv", "--out", str(out))
        self.assertEqual(len(list(csv.DictReader(io.StringIO(out.read_text())))), 6)
        self.assertEqual(len(json.loads(self.run_cli("export", "--format", "json").stdout)), 6)

    def test_migrations_tracked_once(self):
        self.run_cli("init")
        self.run_cli("init")
        names = [r[0] for r in sqlite3.connect(self.env["TASKS_DB"]).execute("SELECT name FROM schema_version ORDER BY name")]
        self.assertEqual(names, ["001_init.sql", "002_tags.sql"])


if __name__ == "__main__":
    unittest.main()

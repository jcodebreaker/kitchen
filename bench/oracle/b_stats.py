# Hidden oracle (bench): done late tasks are not overdue; open late ones are.
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class Oracle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "TASKS_DB": str(Path(self.tmp.name) / "t.db")}

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, *a):
        return subprocess.run([sys.executable, "-m", "tasks", *a], env=self.env, capture_output=True, text=True)

    def test_overdue_counts_open_tasks_only(self):
        self.cli("add", "late and done", "--due", "2020-01-01")
        self.cli("add", "late and open", "--due", "2020-01-02")
        self.cli("add", "future", "--due", "2099-01-01")
        self.cli("done", "1")
        s = json.loads(self.cli("stats", "--json").stdout)
        self.assertEqual(s["overdue"], 1, s)
        self.assertEqual((s["total"], s["done"], s["open"]), (3, 1, 2), s)


if __name__ == "__main__":
    unittest.main()

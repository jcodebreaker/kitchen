# Hidden oracle (bench): `tasks done` takes several ids; an unknown id changes nothing.
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
        for t in ("one", "two", "three"):
            self.cli("add", t)

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, *a):
        return subprocess.run([sys.executable, "-m", "tasks", *a], env=self.env, capture_output=True, text=True)

    def open_ids(self):
        return sorted(t["id"] for t in json.loads(self.cli("list", "--json").stdout))

    def test_several_ids(self):
        p = self.cli("done", "1", "2")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.open_ids(), [3])

    def test_unknown_id_changes_nothing(self):
        p = self.cli("done", "3", "99")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("99", p.stderr + p.stdout)
        self.assertEqual(self.open_ids(), [1, 2, 3])


if __name__ == "__main__":
    unittest.main()

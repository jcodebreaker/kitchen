# Hidden oracle (bench): titles over 200 characters are refused; 200 is fine.
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

    def test_limit(self):
        p = self.cli("add", "x" * 201)
        self.assertEqual(p.returncode, 1)
        self.assertIn("title is too long (max 200 characters)", p.stderr)
        self.assertEqual(self.cli("add", "y" * 200).returncode, 0)


if __name__ == "__main__":
    unittest.main()

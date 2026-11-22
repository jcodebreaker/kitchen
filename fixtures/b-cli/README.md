# tasks

A small task tracker for the terminal, backed by SQLite. Python 3.11+, standard library only.

## Install

```sh
pip install -e .        # gives you the `tasks` command
# or, with no install at all, from the repo root:
python3 -m tasks --help
```

## Configuration

| Variable   | Default                         | Meaning                     |
| ---------- | ------------------------------- | --------------------------- |
| `TASKS_DB` | `~/.local/share/tasks/tasks.db` | Path of the SQLite database |

The database and its folder are created on first use. `tasks init` creates it explicitly; every other command does the same automatically.
Schema changes live in `tasks/migrations/*.sql`, are applied in filename order and recorded in the `schema_version` table.

## Usage

Every command accepts `--json` for machine-readable output. Errors print `error: ...` on stderr and exit with status 1.

```sh
python3 -m tasks add "Write the report" --due 2030-06-01 --tag work --tag docs
python3 -m tasks list                 # open tasks; --tag work to filter, --all to include done
python3 -m tasks done 1
python3 -m tasks edit 1 --title "Write the Q2 report"
python3 -m tasks search report
python3 -m tasks stats
python3 -m tasks purge                # asks "Delete N done tasks? [y/N]"; --yes skips the question
python3 -m tasks export --format csv --out tasks.csv
python3 -m tasks import tasks.csv
```

To try it with sample data: `python3 -m tasks import seed/demo.csv`.

CSV columns: `title,due,done,tags` (tags are separated by `;`).

## Tests

```sh
python3 -m unittest
```

Tests run the CLI in a subprocess against a temporary `TASKS_DB`; your real database is never touched.

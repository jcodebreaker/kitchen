#!/bin/sh
# Where does Codex load skills from? No model call: `codex debug prompt-input` renders what the model would see.
# Plants probe skills in a throwaway repo and checks which ones appear, from a nested subfolder.
set -e  # (the claude call below is allowed to fail)
HERE=$(cd "$(dirname "$0")" && pwd)
R="$HERE/.work/skills/repo"
rm -rf "$R"; mkdir -p "$R/sub/deep"
git init -q "$R"
plant() { mkdir -p "$1/$2"; printf -- "---\nname: $2\ndescription: probe skill $2\n---\nbody\n" > "$1/$2/SKILL.md"; }
plant "$R/.agents/skills" kitchen-repo-agents      # <repo>/.agents/skills
plant "$R/sub/.agents/skills" kitchen-sub-agents   # a folder between repo root and cwd
plant "$R/.codex/skills" kitchen-repo-dotcodex     # <repo>/.codex/skills
plant "$R/.claude/skills" kitchen-repo-dotclaude   # does Codex read Claude's folder? (expect no)
plant "$R/sub/.claude/skills" kitchen-sub-dotclaude
cd "$R/sub/deep"
out=$(npx -y @openai/codex@0.171.0 debug prompt-input 2>&1)
for s in kitchen-repo-agents kitchen-sub-agents kitchen-repo-dotcodex kitchen-repo-dotclaude kitchen-sub-dotclaude; do
  case "$out" in *"$s"*) echo "SEEN     codex $s" ;; *) echo "NOT SEEN codex $s" ;; esac
done
# every skill root Codex resolved (plugin caches left out)
printf '%s' "$out" | grep -o -E '`r[0-9]+` = `[^`]+`' | grep -v plugins/cache | sed "s|$HOME|~|"

# Claude Code: one tiny model call (haiku) from the same nested folder.
if [ "$1" = "--claude" ]; then
  ans=$(${CLAUDE:-claude} -p --model haiku --max-turns 1 --permission-mode dontAsk -- \
    "List the names of every skill available to you whose name starts with 'kitchen-'. One line, comma separated, nothing else." 2>&1) || true
  echo "claude says: $ans"
fi

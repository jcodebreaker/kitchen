# Choose each lane's model, per tool, from what you have

**Status.** Accepted, 2026-11-24, by the user ("yes"). Builds on ADR 0016 (`models:` tiers in kitchen.yaml).

## Why

Each lane's model is already a setting (`models: { intake: strong, … }`, tiers mapped by `agent.models`), but nothing shows what you can choose, the setting is per repo not per tool, and the dashboard never says which tool and models the queue runs on ("how do I know the factory runs on Claude or Codex?").

## Decision

1. **`kitchen models`** prints, for the active tool, each lane's model now and the choices:
   - Claude Code: the aliases the CLI takes (`fable`, `opus`, `sonnet`, `haiku`), plus the full list from Anthropic's models API when `ANTHROPIC_API_KEY` is set.
   - Codex: the providers in `~/.codex/config.toml` (`model_provider`, `[model_providers.*]`) and, where a provider answers an OpenAI-style `GET /models`, its models; else the configured `model` only.
   - `kitchen models check` sends one tiny request per chosen model through the tool itself (`claude -p --model X "ok"`, `codex exec -m X "ok"`) and reports which ones answer. It costs a fraction of a cent; nothing else in Kitchen runs it.
2. **One profile per tool** in kitchen.yaml; switching `agent.tool` keeps each tool's choices:
   ```yaml
   models:
     claude: { intake: opus, builder: sonnet, qa: sonnet, reviewer: opus }
     codex:  { intake: gpt-5.4, builder: gpt-5.4-mini, qa: gpt-5.4-mini, reviewer: gpt-5.4 }
   ```
   A value is a tier (`strong`/`medium`/`cheap`, as today) or a model name. The old flat `models: { intake: … }` still works and means the active tool's profile.
3. **The dashboard shows it in one place:** the orchestrator line under the job list says the tool and each lane's model ("Claude Code · intake opus · build sonnet · QA sonnet · review opus · running, pid …"). Clicking it opens per-lane choices filled from `kitchen models`; a change is written to kitchen.yaml and applies from the next lane a job starts.
4. **By talking:** "use Opus for review" in `/kitchen` sets the same.

## Not chosen
- A fixed list of model names in Kitchen: it goes stale; the tools and providers are the source.
- Running `models check` before every run: costs money on every start for something that rarely changes.

## Later
Codex running the queue (its own decision): until then the codex profile is kept but used only by the Codex-side skill.

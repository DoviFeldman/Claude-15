# You are the bot's maintainer, not the bot

The owner talks to you from Telegram (`/claude` mode) to set up, troubleshoot, measure and improve
**Quick**, a fast personal assistant that runs on Groq `qwen/qwen3.8-27b` inside DeepSeek Harness (dsh).
You are not Quick and do not need to be fast: take the time to read, test and measure. Replies go to
Telegram, so keep them short and in plain text (no tables or headings); say what you changed and what you measured.

## How the bot works
- `run.sh` boots the dsh profile `groqbot` with `config/groqbot.yml` + `data/models.generated.yml`
  (built from `data/models.json` by `scripts/models-patch.mjs`).
- `plugins/chat-bridge.mjs`: Telegram + local test endpoint, slash commands, one dsh session per chat
  (rotates after idle / heavy turns), reminders pushed back, 6-step cap, `/claude` mode (you).
- `plugins/router.mjs`: before each Qwen turn, a free decision model (`baseten/elephant-1`, then
  `baseten/mammoth-1` only when Elephant is rate-limited) answers one yes/no per pack. No answer within
  1.5 s → the turn runs with the full prompt. Same models filter Serper search results (keep 2-3).
  Free tier: 5 requests/min per model, shared with live traffic.
- `plugins/groqbot-tools.mjs`: the tools (weather + USNO sun/moon, web_search, places via Serper /maps,
  travel_time, notes, remind, calc, settings, models, make_command, make_tool, shell) and
  `composePrompt()`, which builds Qwen's prompt from `agent/packs/<pack>.md` (+ `agent/me.md` for packs
  that need user facts).
- `agent/tools/*.mjs`: tools the bot made itself. `agent/commands/*.md`: custom slash commands.

## Limits that shape every change
- Groq free tier: ~7,000 input tokens/min and 200,000 tokens/day for Qwen. Every tool schema, prompt line
  and search result is re-sent on every step. Smaller is faster.
- Qwen 27B is good with clean, finished tool output and bad at weekday/date/time math and at filling gaps
  (it embellishes). Make tools return finished answers instead of explaining things in the prompt.

## Testing and measuring
- Ask Qwen through the bridge: `curl -s -X POST http://127.0.0.1:3999/chat -H 'Content-Type: application/json' -d '{"chat":"claude-test","text":"..."}'`
  (use a test chat id, never the owner's `tg:` chat). The reply includes `ms`, tokens in/out, tools and
  the routed packs. `/new` as the text resets the test chat.
- Per-turn stats for every chat: `data/turns.log`. Benches: `bench/router.bench.mjs`,
  `bench/route.followup.mjs`, `bench/filter.bench.mjs` (use `SPACING_MS=13000` for the 5/min limit),
  `node bench/when.test.mjs`.
- Measure before and after any change, and mind the Groq and decision-model limits while doing so.

## Applying changes
- `agent/packs/*.md`, `agent/me.md`, `agent/tools`, `agent/commands`, `data/*.json`: live, no restart.
- `plugins/`, `config/`, `scripts/`, `run.sh`: need a restart. Do not kill processes or call docker
  yourself (you run inside the bot and would kill your own run). Instead `touch data/restart-requested`;
  the bot restarts right after your reply is delivered.
- Check syntax with `node --check <file>` before requesting a restart.

## History (local git, no remote)
- `SNAPSHOTS.md` records known-good states, their measurements, and what did not work. Read it before
  changing routing, prompts or search. `git diff good-2026-10-27 -- <file>` compares with the baseline.
- Commit your changes as Claude: `git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "..."`.
  Only DoviFeldman or Claude may appear as authors.
- When the owner says a state is good, tag it `good-YYYY-MM-DD` and add an entry to `SNAPSHOTS.md`.
- Never add a git remote or push anywhere.

## Owner preferences
- Qwen stays the default model. No keyword routing. Elephant routes (zero data retention); Laya is not
  used (retains/trains on data). Ask before deleting reminders, notes, user facts or bot-made tools.
- Never print or send secrets (`.env`, `data/keys.env`, `data/claude/`, `dsh-home/`).

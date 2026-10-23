# Groqbot: fast personal assistant on DeepSeek Harness + Groq

Groq model: `qwen/qwen3.8-27b` (only). Runs as a custom `dsh` profile (`groqbot`) with:

- `plugins/groqbot-tools.mjs` (preset plugin): prompt from `agent/prompt.md` + `agent/me.md` (re-read every step, so the bot can edit itself), tools `weather` (tomorrow.io), `calc` (exact math + `untilTime`/`daysUntil`), `settings` (idle_minutes, max_steps, changeable by chatting), `web_search` + `places` (serper.dev; `places` falls back to OpenStreetMap), `travel_time` (OSM + OSRM, no traffic), `notes`, `remind` (dsh Host schedule service; `plugins/when.mjs` turns plain English like "every weekday at 7:30am" into the schedule, so the model never writes cron), `shell`, `make_tool` (writes `agent/tools/<name>.mjs` and loads it live).
- `plugins/chat-bridge.mjs` (host plugin): Telegram long-polling + `POST 127.0.0.1:3999/chat {"text","chat"}` for local tests. One session per chat, rotated after 30 min idle or a heavy turn; reminders are pushed to the chat; turns capped at 6 steps.
- `config/groqbot.yml`: Groq route, retry policy for the free-tier TPM limit, `groqbot` preset (replaces DeepSeek's whole prompt).

## Chat commands
`/new` fresh chat · `/continue` back to the previous chat · `/retry` last question in a fresh chat · `/usage` tokens of last answer · `/help` · `/commands`.
Make your own: `/cmd weekend weekend weather and one fun thing to do {args}` -> `/weekend with kids`. Delete: `/cmd weekend`. Stored in `agent/commands/<name>.md`.

## Personal setup (not in git)
- `.env`: API keys and `GROQBOT_HOME_LOCATION` (your city/address).
- `agent/me.md`: facts about you (copy `agent/me.example.md`).

## Free-tier limits (Groq, qwen3.8-27b)
~7,000 input tokens/min and 200,000 tokens/day. An answer costs ~2-10k tokens, so roughly 40-80 questions/day.

## Run locally
    ./run.sh                       # needs: npm i -g @deepseek-ai/dsh
    python3 bench/ask.py "weather?" # test without Telegram
    node bench/when.test.mjs         # reminder-parser tests

## Linux / Docker
    cp .env.example .env   # fill keys + home location
    cp agent/me.example.md agent/me.md
    docker compose up -d --build

Telegram: create a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN`, message the bot once,
it replies with your chat id -> put it in `TELEGRAM_ALLOWED_CHAT_IDS`, restart. `/new` starts a fresh chat.

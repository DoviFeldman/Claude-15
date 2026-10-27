# Groqbot: fast personal assistant on DeepSeek Harness + Groq

Groq model: `qwen/qwen3.8-27b` (only). Runs as a custom `dsh` profile (`groqbot`) with:

- `plugins/groqbot-tools.mjs` (preset plugin): prompt from `agent/prompt.md` + `agent/me.md` (re-read every step, so the bot can edit itself), tools `weather` (tomorrow.io), `calc` (exact math + `untilTime`/`daysUntil`), `settings` (idle_minutes, max_steps, changeable by chatting), `web_search` + `places` (serper.dev; `places` falls back to OpenStreetMap), `travel_time` (OSM + OSRM, no traffic), `notes`, `remind` (dsh Host schedule service; `plugins/when.mjs` turns plain English like "every weekday at 7:30am" into the schedule, so the model never writes cron), `shell`, `make_tool` (writes `agent/tools/<name>.mjs` and loads it live).
- `plugins/chat-bridge.mjs` (host plugin): Telegram long-polling + `POST 127.0.0.1:3999/chat {"text","chat"}` for local tests. One session per chat, rotated after 30 min idle or a heavy turn; reminders are pushed to the chat; turns capped at 6 steps.
- `config/groqbot.yml`: Groq route, retry policy for the free-tier TPM limit, `groqbot` preset (replaces DeepSeek's whole prompt).

## Topic packs + router (token saver)
Each message is routed (`plugins/router.mjs`) to the packs it needs: `places`, `web`, `weather`, `reminders`, `self`
(+ `core`, always). Only those packs' instructions (`agent/packs/<pack>.md`) and tools are shown to the model, and
user facts ride along only with packs that use them. Routing uses a free zero-data-retention decision model on Vercel AI Gateway (`AI_GATEWAY_API_KEY`): `ROUTER_MODELS`
(default `baseten/elephant-1,baseten/mammoth-1`) are tried in order, the next only when one is rate-limited (free
tier: 5 req/min per model). The previous message is included so follow-ups keep their topic. If no model answers
within `ROUTER_TIMEOUT_MS` (1500), the turn simply runs unrouted (full prompt, all tools). `FILTER_MODELS` trims
Serper results the same way (fallback: Google's top 3).
`SPACING_MS=13000 node bench/router.bench.mjs <model>` grades routing; `node bench/filter.bench.mjs <models>` compares result picks.

## Models
`data/models.json` lists models (`default`, `roles`, `models`); `scripts/models-patch.mjs` turns it into dsh config at
startup. From Telegram: `/model` (list), `/model name` (switch), `/model add name provider model-id`
(providers: groq, xai, vercel, openai, openrouter), `/model role self name` (send self-editing turns to another model),
`/key NAME value` (stores an API key in `data/keys.env`, deletes your message), `/restart` (Docker brings it back), `/login grok` (xAI device-code sign-in with a SuperGrok / X Premium account: the bot sends a link + code, the token is stored in dsh's credential store, Grok is added with `auth: oauth` and self-editing turns are routed to it), `/logout grok`.
The bot can do the same by being asked (tools `models`, `make_command`).

## Chat commands
`/continue` back to the previous chat · `/retry` last question in a fresh chat · `/usage` tokens of last answer · `/help` · `/commands` · `/new` fresh chat (kept last in the menu).
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

Without the compose plugin (plain Docker):

    docker build -t groqbot .
    docker run -d --name groqbot --restart unless-stopped \
      -v $PWD/.env:/app/.env:ro -v $PWD/agent:/app/agent \
      -v $PWD/data:/app/data -v $PWD/dsh-home:/app/dsh-home groqbot
    docker logs -f groqbot      # watch it
    docker restart groqbot      # after editing prompt.md / plugins

Only run one copy per Telegram token (two pollers fight over updates).

Telegram: create a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN`, message the bot once,
it replies with your chat id -> put it in `TELEGRAM_ALLOWED_CHAT_IDS`, restart. `/new` starts a fresh chat.

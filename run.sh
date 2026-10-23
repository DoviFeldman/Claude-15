#!/bin/sh
# Start the groqbot dsh profile: Telegram (if TELEGRAM_BOT_TOKEN is set),
# local test API on 127.0.0.1:3999, Web UI on 127.0.0.1:3080.
cd "$(dirname "$0")"
ROOT="$PWD"
[ -f .env ] && { set -a; . ./.env; set +a; }
export GROQBOT_HOME="$ROOT" DSH_HOME="${DSH_HOME:-$ROOT/dsh-home}" DSH_TELEMETRY_MODE=DISABLED
mkdir -p data agent/tools plugins/node_modules
[ -f data/notes.json ] || echo '[]' > data/notes.json
[ -f agent/me.md ] || cp agent/me.example.md agent/me.md
# Let the plugins import dsh's own packages.
ln -sfn "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai" plugins/node_modules/@deepseek-ai
sed "s|__ROOT__|$ROOT|g" config/groqbot.yml > data/groqbot.generated.yml
[ -d "$DSH_HOME/profiles/groqbot" ] || dsh groqbot --from-default-profile web --dump-config >/dev/null
exec dsh groqbot --patch ./data/groqbot.generated.yml --no-open "$@"

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@0.2.1-rc.2 @anthropic-ai/claude-code@2.1.312 \
 && git config --global --add safe.directory /app
WORKDIR /app
# The whole bot folder is mounted at /app (see README), so edits made from /claude mode apply on
# restart without a rebuild. These copies only matter if the image runs without the mount.
COPY plugins/*.mjs plugins/
COPY config config
COPY scripts scripts
COPY run.sh .
ENV TZ=America/New_York
# Claude Code's sign-in lives in the mounted data folder so it survives rebuilds.
ENV CLAUDE_CONFIG_DIR=/app/data/claude
CMD ["./run.sh"]

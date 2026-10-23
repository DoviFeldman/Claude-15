FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@0.2.1-rc.2
WORKDIR /app
COPY plugins/*.mjs plugins/
COPY config config
COPY run.sh .
# agent/ (prompt, facts, self-made tools), data/ and dsh-home/ are volumes so self-edits survive rebuilds.
ENV TZ=America/New_York
CMD ["./run.sh"]

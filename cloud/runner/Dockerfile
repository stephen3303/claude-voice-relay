# Bridge Cloud's agent runner (cloud/runner/main.mjs), built by CDK (cloud/infra/lib/api.mjs) from the repo root,
# with only the files below in the build context. It mirrors the repo's layout, so the runner imports the
# relay's own cloud-agents.mjs, agent-turn.mjs and ntfy.mjs unchanged.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Pinned: the runner reads what `claude -p --cloud` prints (cloud-agents.mjs parseCloud). Bump it on purpose.
ARG CLAUDE_CODE_VERSION=2.1.303
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
WORKDIR /app
COPY cloud/runner/package.json cloud/runner/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY cloud-agents.mjs agent-turn.mjs ntfy.mjs ./
COPY cloud/api/inbox.mjs cloud/api/status.mjs cloud/api/voice.mjs cloud/api/auth.mjs cloud/api/owner.mjs ./cloud/api/
COPY cloud/runner/main.mjs cloud/runner/turns.mjs cloud/runner/repo.mjs ./cloud/runner/
# Claude Code keeps its login in ~/.claude; the runner writes it there at start.
USER node
ENV HOME=/home/node
CMD ["node", "cloud/runner/main.mjs"]

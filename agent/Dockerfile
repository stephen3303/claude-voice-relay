FROM node:22-bookworm-slim
# relay.mjs refuses older images (AGENT_IMAGE_VERSION); bump both together.
LABEL claude-voice-relay.image="3"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
USER node
# Mirror the host's line-ending policy and trust the bind-mounted repo. There's no GitHub credential here:
# agents only commit, and the relay pushes from separate runs of this image (publish.mjs); only the last gets the token.
RUN mkdir -p /home/node/.claude \
 && git config --global core.autocrlf input \
 && git config --global --add safe.directory '*' \
 && git config --global url."https://github.com/".insteadOf git@github.com:
WORKDIR /work
CMD ["sleep", "infinity"]

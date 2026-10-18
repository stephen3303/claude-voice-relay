FROM node:22-bookworm-slim
# relay.mjs refuses older images (AGENT_IMAGE_VERSION); bump both together.
LABEL claude-voice-relay.image="2"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 python3-pip python3-venv \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
USER node
# Mirror the host's line-ending policy, trust the bind-mounted repo, push over HTTPS with GH_TOKEN
# (offered to github.com only, so another host a dependency points at never sees it).
# The relay sets GH_TOKEN for each turn (a GitHub App token for this repo only); gh reads it too.
RUN mkdir -p /home/node/.claude \
 && git config --global core.autocrlf input \
 && git config --global --add safe.directory '*' \
 && git config --global url."https://github.com/".insteadOf git@github.com: \
 && git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
WORKDIR /work
CMD ["sleep", "infinity"]

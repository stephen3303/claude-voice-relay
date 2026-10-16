FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
USER node
# Mirror the host's line-ending policy, trust the bind-mounted repo, push over HTTPS with GH_TOKEN.
RUN mkdir -p /home/node/.claude \
 && git config --global core.autocrlf input \
 && git config --global --add safe.directory '*' \
 && git config --global url."https://github.com/".insteadOf git@github.com: \
 && git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
WORKDIR /work
CMD ["sleep", "infinity"]

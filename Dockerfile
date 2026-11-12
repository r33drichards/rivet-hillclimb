FROM debian:trixie-slim AS mcp
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) asset=mcp-v8-linux.gz ;; arm64) asset=mcp-v8-linux-arm64.gz ;; *) exit 1 ;; esac; \
    curl -fsSL --retry 3 "https://github.com/r33drichards/mcp-js/releases/download/v0.22.0/$asset" | gzip -d > /mcp-v8 && chmod 755 /mcp-v8
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY --from=mcp /mcp-v8 /usr/local/bin/mcp-v8
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY assets ./assets
USER node
EXPOSE 3000
CMD ["npm", "start"]

# TreeBots cloud worker — production image
FROM node:20-bookworm-slim

# mineflayer deps occasionally need build tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# App code
COPY index.js ./

# Northflank sets these via the service's environment / secrets
ENV NODE_ENV=production
ENV API_BASE=https://tree-bot-core.base44.app
ENV POLL_MS=5000

CMD ["node", "index.js"]

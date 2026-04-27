FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY config ./config
COPY assets ./assets
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=Europe/Kyiv

RUN apt-get update \
  && apt-get install -y --no-install-recommends ghostscript ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/assets ./assets
COPY migrations ./migrations

RUN mkdir -p /app/storage/files/materials /app/storage/temp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/readiness').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--max-old-space-size=768", "dist/index.js"]

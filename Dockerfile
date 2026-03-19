FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY config ./config
COPY reference ./reference
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ghostscript ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/reference ./reference

RUN mkdir -p /app/storage/files/materials /app/storage/temp

EXPOSE 3000

CMD ["node", "dist/index.js"]

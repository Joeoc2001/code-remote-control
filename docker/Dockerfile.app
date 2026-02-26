# Stage 1 — Build
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/client/package.json ./packages/client/
COPY packages/server/package.json ./packages/server/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/client/ ./packages/client/
COPY packages/server/ ./packages/server/

RUN npm run build

# Stage 2 — Runtime
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

RUN npm ci --omit=dev

COPY packages/shared/ ./packages/shared/
COPY --from=build /app/packages/server/dist/ ./packages/server/dist/
COPY --from=build /app/packages/client/dist/ ./packages/client/dist/

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]

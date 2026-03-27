FROM node:22-alpine AS build
ARG BUILD_ID=unknown

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/container-metadata-types/package.json ./packages/container-metadata-types/
COPY packages/client/package.json ./packages/client/
COPY packages/server/package.json ./packages/server/

RUN npm ci \
  --workspace packages/shared \
  --workspace packages/container-metadata-types \
  --workspace packages/client \
  --workspace packages/server

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/container-metadata-types/ ./packages/container-metadata-types/
COPY packages/client/ ./packages/client/
COPY packages/server/ ./packages/server/

RUN echo "{\"buildId\":\"${BUILD_ID}\"}" > packages/server/build-info.json

RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/container-metadata-types/package.json ./packages/container-metadata-types/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

RUN npm ci --omit=dev \
  --workspace packages/shared \
  --workspace packages/container-metadata-types \
  --workspace packages/server \
  --workspace packages/client

COPY packages/shared/ ./packages/shared/
COPY packages/container-metadata-types/ ./packages/container-metadata-types/
COPY --from=build /app/packages/server/dist/ ./packages/server/dist/
COPY --from=build /app/packages/server/build-info.json ./packages/server/build-info.json
COPY --from=build /app/packages/client/dist/ ./packages/client/dist/
COPY opencode/ ./opencode/

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]

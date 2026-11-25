# Railway·Docker용 이미지. 데이터는 /data 볼륨에 두고 ACR_DB=/data/acr.db 로 가리킨다.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY core ./core
COPY runtime ./runtime
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    ACR_HOST=0.0.0.0 \
    ACR_DB=/data/acr.db \
    ACR_PURGE_INTERVAL_MS=3600000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
# 볼륨을 붙이지 않아도 최소한 이 컨테이너 안에서는 동작하게 만든다(재배포 시 데이터는 사라진다).
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "dist/src/server.js"]

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY deploy/gateway/package.json deploy/gateway/package-lock.json .npmrc tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=8787 STATE_DB=/data/gateway.sqlite
WORKDIR /app
RUN install -d -m 0700 -o node -g node /data
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node vendor/desktop-commander-full/catalog.json ./vendor/desktop-commander-full/catalog.json
COPY --chown=node:node web ./web
USER node
EXPOSE 8787
CMD ["node", "dist/gateway.js"]

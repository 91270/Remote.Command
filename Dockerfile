FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY deploy/gateway/package.json deploy/gateway/package-lock.json .npmrc tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts
COPY package.json package-lock.json agent.example.json README.md ./
COPY vendor ./vendor
COPY scripts/package-client.mjs ./scripts/package-client.mjs
RUN npm exec -- node scripts/package-client.mjs /app/assets

FROM node:24-bookworm-slim
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=8787 STATE_DB=/data/gateway.sqlite
WORKDIR /app
RUN install -d -m 0700 -o node -g node /data
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node vendor/desktop-commander-full/catalog.json ./vendor/desktop-commander-full/catalog.json
COPY --chown=node:node web ./web
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --start-interval=1s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/gateway.js"]

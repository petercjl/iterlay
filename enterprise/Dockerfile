ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY enterprise/package.json enterprise/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared ./shared
COPY electron ./electron
COPY enterprise/src ./enterprise/src
RUN ./node_modules/.bin/esbuild enterprise/src/main.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=server.js
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/server.js ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
USER node
EXPOSE 18473
CMD ["node", "server.js"]

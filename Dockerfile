# Imagem final só com dependências de runtime
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache su-exec
ENV NODE_ENV=production
ENV MCP_HUB_TRANSPORT=http
ENV MCP_HUB_HTTP_HOST=0.0.0.0
ENV MCP_HUB_HTTP_PORT=3343
ENV MCP_HUB_HTTP_PATH=/mcp
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY public ./public
COPY mcp-hub.config.json ./mcp-hub.config.json
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENV MCP_HUB_USERS_FILE=/app/data/hub-users.json
ENV MCP_HUB_MCP_REGISTRY_FILE=/app/data/hub-mcp-registry.json
EXPOSE 3343
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/hub.js"]

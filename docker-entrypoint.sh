#!/bin/sh
# Volumes em /app/data costumam vir com dono root; o hub corre como utilizador `node`.
mkdir -p /app/data
if ! chown -R node:node /app/data 2>/dev/null; then
  echo "[docker-entrypoint] Aviso: não foi possível chown /app/data (bind mount read-only ou restrições do host)." >&2
  echo "[docker-entrypoint] Garanta escrita para UID 1000 (node) ou defina MCP_HUB_MONGODB_URI." >&2
fi
exec su-exec node "$@"

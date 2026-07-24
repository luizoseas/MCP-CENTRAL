# Referência de variáveis de ambiente

Fonte canónica comentada: `.env.example` na raiz do repo.

## e-ship

| Variável | Uso |
|----------|-----|
| `ESHIP_API_KEY` | Chave genérica / fallback |
| `ESHIP_API_KEY_WMS` | Substitui `ESHIP_API_KEY` em upstreams `eship-wms-*` |
| `ESHIP_API_KEY_TAR` | Idem para `eship-tar-*` |
| `ESHIP_API_BASE_URL` | Base HTTP(S) da API e-ship |

## Transporte do hub

| Variável | Default / notas |
|----------|-----------------|
| `MCP_HUB_TRANSPORT` | `http` ou `stdio` |
| `MCP_HUB_CONFIG` | Path do JSON de servidores |
| `MCP_HUB_HTTP_HOST` | `0.0.0.0` |
| `MCP_HUB_HTTP_PORT` | `3343` |
| `MCP_HUB_HTTP_PATH` | `/mcp` |
| `MCP_PUBLIC_PORT` | Porta publicada no Compose |
| `MCP_HUB_ALLOWED_HOSTS` | Hosts permitidos (vírgula) |
| `MCP_HUB_TRUST_PROXY` | `1` atrás de nginx/HTTPS |
| `MCP_HUB_TOOL_NAME_MAX_LEN` | 32–128; default 60 |
| `MCP_HUB_JSON_BODY_LIMIT` | default `10mb` |

## OAuth / Cursor

| Variável | Uso |
|----------|-----|
| `MCP_HUB_OAUTH_PUBLIC_ORIGIN` | Origem pública HTTPS |
| `MCP_HUB_OAUTH_RESOURCE_URL` | Resource PRM (opcional) |
| `MCP_HUB_OAUTH_COERCE_HTTPS` | Default coerção on; `0` desliga |
| `MCP_HUB_OAUTH_STUB_ACCESS_TOKEN` | Token stub opcional |

## Admin

| Variável | Uso |
|----------|-----|
| `MCP_HUB_ADMIN_PASSWORD` | Login local + conta `admin` com LDAP |
| `MCP_HUB_ADMIN_SECRET` | HMAC cookie; obrigatório com LDAP |

## LDAP

| Variável | Uso |
|----------|-----|
| `MCP_HUB_LDAP_URL` | `ldap://` / `ldaps://` |
| `MCP_HUB_LDAP_BASE_DN` | Modo directo (B1) |
| `MCP_HUB_LDAP_USER_DN_TEMPLATE` | Deve incluir `{{username}}` |
| `MCP_HUB_LDAP_BIND_DN` / `_PASSWORD` / `USER_SEARCH_BASE` | Modo serviço (B2) — as três juntas |
| `MCP_HUB_LDAP_USER_FILTER` | Com `{{username}}` |
| `MCP_HUB_LDAP_SEARCH_SCOPE` | ex. `sub` |
| `MCP_HUB_LDAP_TIMEOUT_MS` | Timeout |
| `MCP_HUB_LDAP_TLS_INSECURE` | `1` só em lab |

## Persistência

| Variável | Uso |
|----------|-----|
| `MCP_HUB_USERS_FILE` | JSON utilizadores |
| `MCP_HUB_MCP_REGISTRY_FILE` | JSON catálogo/templates |
| `MCP_HUB_MONGODB_URI` | Se definido → Mongo em vez de ficheiros |
| `MCP_HUB_MONGODB_DB` | default `mcp_hub` |
| `MCP_HUB_MONGODB_COLLECTION` | default `hub_state` |

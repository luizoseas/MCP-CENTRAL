---
name: mcp-central
description: >-
  Desenvolve, configura e opera o hub MCP-CENTRAL (agregação de servidores MCP,
  admin, tokens, e-ship WMS/TAR). Use ao trabalhar neste repositório, em
  mcp-hub.config.json, Docker, LDAP/admin, nomes de tools, ou ao consultar
  APIs e-ship via tools do hub (mcp_hub__meta, webService*).
---

# Skill MCP-CENTRAL

## Quando aplicar

- Alterar `src/hub.ts`, `src/admin/*`, UI em `public/hub-admin/`
- Configurar `mcp-hub.config.json`, `.env`, Docker Compose, Cursor mcp.json
- Depurar ligação HTTP `/mcp`, OAuth/PRM, nomes truncados de tools
- Usar o hub ligado no Cursor para operações WMS/TAR e-ship

## 1. Desenvolvimento do hub

1. Ler o código alvo em `src/` antes de editar; espelhar padrões existentes.
2. Schemas Zod: `HubServerDefSchema` (stdio **ou** `streamableHttp`).
3. Novas funções exportadas usadas em testes → atualizar/criar `*.test.ts` e correr `npm test`.
4. Admin: tipos em `src/admin/types.ts` (`schemaVersion: 2` — users, api_tokens, token_mcps).
5. Persistência: sem `MCP_HUB_MONGODB_URI` → JSON (`MCP_HUB_USERS_FILE`, `MCP_HUB_MCP_REGISTRY_FILE`); com URI → Mongo (`mcp_hub` / `hub_state`).

Checklist rápido:

```
- [ ] Tipos/Zod coerentes com HubConfig
- [ ] Sem secrets no git
- [ ] npm test passa (se tocou naming/auth/store)
- [ ] Placeholders ${VAR} documentados no .env.example se forem novos
```

## 2. Configurar um servidor no hub

**Preferido (e-ship / HTTP remoto):**

```json
"eship-wms-exemplo": {
  "streamableHttp": {
    "url": "https://exemplo.mcp.eship.com.br/mcp",
    "headers": {
      "X-Eship-Api-Key": "${ESHIP_API_KEY}",
      "X-Eship-Api-Base-Url": "${ESHIP_API_BASE_URL}"
    }
  }
}
```

**Stdio:**

```json
"meu-mcp": {
  "command": "npx",
  "args": ["-y", "@algum/server"],
  "env": { "TOKEN": "${MEU_TOKEN}" }
}
```

- Chaves WMS: `eship-wms-*`; TAR: `eship-tar-*` (filtro por módulo no hub).
- Cliente Cursor stdio: ver `cursor-eship-hub.example.json`.
- Cliente Cursor HTTP: ver `cursor-mcp-http-hub.example.json` (porta default `3343`, path `/mcp`).

## 3. Credenciais e-ship (HTTP initialize)

Headers úteis no primeiro POST:

| Header | Efeito |
|--------|--------|
| `X-Eship-Api-Key` / `X-Api-Key` | Chave única |
| `X-Eship-Api-Key-WMS` + `X-Eship-Api-Key-TAR` | WMS e TAR em paralelo |
| `X-Eship-Api-Base-Url` / `X-Api-Base-Url` | Base `http://` ou `https://` |
| `X-MCP-Hub-User-Token` | Token do painel admin (filtro MCPs do utilizador) |

`_meta` no initialize também aceita `eshipApiKeyWms`, `eshipApiKeyTar`, `eshipApiBaseUrl`, etc.

Stdio: passar `ESHIP_*` no `env` da entrada do hub no mcp.json.

## 4. Usar tools do hub no Cursor

1. Chamar `mcp_hub__meta` para mapear `SERVIDOR__tool` → tool upstream.
2. Descobrir schema com GetMcpTools antes de CallMcpTool.
3. Nomes truncados (sufixo `_` + 8 hex): resolver via `mcp_hub__meta`, não adivinhar.
4. Hub só expõe **Tools** (sem prompts/resources agregados).
5. O `tools/list` reexpõe o **inputSchema** (body) de cada MCP filho — preencher esses campos; o hub repassa o JSON sem revalidar a forma do filho.
6. Operações destrutivas (Delete/Post/Put): confirmar com o utilizador se o pedido for ambíguo.

Domínios típicos WMS (pelo nome da tool upstream): armazém, cadastro, inventário, recebimento, ordem, produto/estoque, operação (picking/volume), transporte/embarque, utilizador, sistema.

## 5. Admin e LDAP

- UI: `http://localhost:3343/hub-admin`
- Local: `MCP_HUB_ADMIN_PASSWORD` (+ opcional `MCP_HUB_ADMIN_SECRET`)
- LDAP: `MCP_HUB_LDAP_URL` + `MCP_HUB_LDAP_BASE_DN` (modo directo) **ou** trio BIND + `USER_SEARCH_BASE`
- Conta `admin` (minúsculas) é local — não vai ao AD
- Papéis: Administrator (inclui excluir); Lideranca / outros = sem exclusão

Detalhe de env: [reference-env.md](reference-env.md).

## 6. Depuração frequente

| Sintoma | Verificar |
|---------|-----------|
| Tool não aparece / nome estranho | `mcp_hub__meta`, `MCP_HUB_TOOL_NAME_MAX_LEN` |
| 401 / chave inválida | Headers initialize vs `.env`; WMS vs TAR |
| EACCES em Docker | ownership do volume `/app/data` (user `node`) |
| OAuth http vs https | `MCP_HUB_TRUST_PROXY`, `MCP_HUB_OAUTH_PUBLIC_ORIGIN`, `MCP_HUB_OAUTH_COERCE_HTTPS` |
| LDAP «conta de serviço» | `MCP_HUB_LDAP_BIND_*` (não a password do formulário) |
| Nenhum MCP no módulo | prefixos `eship-wms-` / `eship-tar-` na config |

## Exemplos de pedidos

- «Adiciona o MCP X ao hub» → editar `mcp-hub.config.json` + placeholders
- «Porque o nome da tool foi truncado?» → explicar `hubToolName` + meta
- «Lista armazéns» → GetMcpTools + tool GetArmazem via hub
- «Corrige filtro LDAP» → `src/admin/ldapAuth.ts` + `.env.example`

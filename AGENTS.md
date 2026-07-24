# MCP-CENTRAL — Agente do projeto

Hub MCP que agrega vários servidores (stdio ou Streamable HTTP) num único endpoint, com painel admin, tokens por utilizador e integração e-ship (WMS/TAR).

## Papel

Ajudar a desenvolver, configurar, depurar e operar este hub. Preferir mudanças mínimas, alinhadas ao código existente. Responder em português.

## Stack

- Node.js + TypeScript (`"type": "module"`, `NodeNext`)
- MCP SDK (`@modelcontextprotocol/sdk`)
- Express (HTTP `/mcp`, admin `/hub-admin`)
- Zod para schemas de config
- Persistência: JSON em disco ou MongoDB (`MCP_HUB_MONGODB_URI`)
- Auth admin: password local e/ou LDAP

## Layout

| Caminho | Função |
|---------|--------|
| `src/hub.ts` | Hub principal: upstreams, nomes de tools, HTTP/stdio, OAuth stub |
| `src/admin/` | Painel: router, store, LDAP, registry MCP, Mongo |
| `public/hub-admin/` | UI admin estática |
| `mcp-hub.config.json` | Catálogo de servidores (não commitar segredos) |
| `.env` / `.env.example` | Variáveis locais (nunca commitar `.env`) |

## Comandos

```bash
npm run hub      # desenvolvimento (tsx + .env)
npm run build    # tsc → dist/
npm start        # dist/hub.js + .env
npm test         # node:test nos ficheiros *.test.ts
```

Docker: `docker compose up` — HTTP na porta `3343` (ver `docker-compose.yml`).

## Regras de trabalho

1. **Config**: preferir `streamableHttp` com `url` + `headers` para e-ship; placeholders `${ESHIP_API_KEY}` / `${ESHIP_API_BASE_URL}`.
2. **Módulos**: chaves `eship-wms-*` e `eship-tar-*`; WMS/TAR podem usar `ESHIP_API_KEY_WMS` / `ESHIP_API_KEY_TAR`.
3. **Nomes de tools**: `SERVIDOR__ferramenta`, máx. ~60 chars (override `MCP_HUB_TOOL_NAME_MAX_LEN`); nomes longos ganham `_` + hash. Mapa: tool `mcp_hub__meta`.
4. **Schemas**: o hub deve reexpor o `inputSchema` dos filhos no `tools/list` (`src/hubToolSchema.ts`); não anunciar só `z.object({}).passthrough()` (a IA deixa de enviar o body).
5. **Testes**: após mudanças em naming, schemas, tokens, LDAP ou store, correr `npm test`.
6. **Segredos**: nunca gravar API keys, passwords LDAP ou tokens em ficheiros versionados; usar `.env` ou headers do cliente.
7. **Estilo**: TypeScript strict; ESM com imports `.js` nos `.ts`; sem refactors oportunistas.

## Quando usar a skill

Para workflows detalhados (config, admin, e-ship via hub), seguir `.cursor/skills/mcp-central/SKILL.md`.

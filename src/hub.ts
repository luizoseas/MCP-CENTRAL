/**
 * MCP Hub: agrega vários servidores MCP (stdio para Cursor ou HTTP Streamable MCP).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolResult,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { createHubAdminRouter } from "./admin/router.js";
import { getMcpRegistryStore } from "./admin/mcpRegistryStore.js";
import { HubUserStore } from "./admin/store.js";
import type { HubConnectionOverrides, TokenMcpRecord } from "./admin/types.js";

const HubStdioServerDefSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const HubStreamableServerDefSchema = z.object({
  streamableHttp: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});

export const HubServerDefSchema = z.union([
  HubStdioServerDefSchema,
  HubStreamableServerDefSchema,
]);

const HubConfigSchema = z.object({
  mcpServers: z.record(z.string(), HubServerDefSchema),
});

export type HubConfig = z.infer<typeof HubConfigSchema>;
export type HubServerDef = z.infer<typeof HubServerDefSchema>;
type ServerDef = HubConfig["mcpServers"][string];

/** Subconjunto do hub por módulo (prefixos das chaves em mcp-hub.config.json). */
type HubModuleTag = "wms" | "tar";

const HUB_MODULE_PREFIX: Record<HubModuleTag, string> = {
  wms: "eship-wms-",
  tar: "eship-tar-",
};

function filterHubConfigByModule(
  config: HubConfig,
  moduleTag: HubModuleTag,
): HubConfig {
  const prefix = HUB_MODULE_PREFIX[moduleTag];
  const mcpServers: Record<string, ServerDef> = {};
  for (const [k, v] of Object.entries(config.mcpServers)) {
    if (k.startsWith(prefix)) {
      mcpServers[k] = v;
    }
  }
  if (Object.keys(mcpServers).length === 0) {
    throw new Error(
      `Nenhum servidor MCP no módulo ${moduleTag.toUpperCase()} (esperado prefixo de chave: "${prefix}").`,
    );
  }
  return { mcpServers };
}

function sessionHubConfig(
  fullConfig: HubConfig,
  moduleTag: HubModuleTag | null,
): HubConfig {
  if (moduleTag === null) {
    return fullConfig;
  }
  return filterHubConfigByModule(fullConfig, moduleTag);
}

export type Upstream = {
  key: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Map<string, string>;
};

const passthroughArgs = z.object({}).passthrough();

const ENV_VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function envVarNamesInString(s: string): string[] {
  return [...s.matchAll(new RegExp(ENV_VAR_REF.source, "g"))].map((m) => m[1]!);
}

type EnvLookup = Record<string, string | undefined>;

function getEnvValue(env: EnvLookup, name: string): string | undefined {
  const v = env[name];
  if (v === undefined || v === "") {
    return undefined;
  }
  return v;
}

/** Expansão `${ESHIP_API_KEY}`: upstreams WMS usam ESHIP_API_KEY_WMS se existir; TAR usam ESHIP_API_KEY_TAR. */
function effectiveEnvForUpstream(base: EnvLookup, serverKey: string): EnvLookup {
  const out: EnvLookup = { ...base };
  if (serverKey.startsWith("eship-wms-")) {
    const w = getEnvValue(base, "ESHIP_API_KEY_WMS");
    if (w) {
      out.ESHIP_API_KEY = w;
    }
  } else if (serverKey.startsWith("eship-tar-")) {
    const t = getEnvValue(base, "ESHIP_API_KEY_TAR");
    if (t) {
      out.ESHIP_API_KEY = t;
    }
  }
  return out;
}

/** API e-ship: só `http://` e `https://` (rejeita ws:, file:, etc.). */
function assertEshipApiBaseUrlUsesHttpOrHttps(env: EnvLookup): void {
  const raw = getEnvValue(env, "ESHIP_API_BASE_URL");
  if (!raw) {
    return;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`ESHIP_API_BASE_URL não é um URL válido: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `ESHIP_API_BASE_URL tem de ser http:// ou https:// (recebido: ${u.protocol}).`,
    );
  }
}

/** Esquema público do pedido; com proxy, se qualquer valor em X-Forwarded-Proto for https, usa https. */
function inferPublicHttpScheme(req: Request): "http" | "https" {
  const xf = req.get("x-forwarded-proto");
  if (xf) {
    const parts = xf.split(",").map((p) => p.trim().toLowerCase());
    if (parts.some((p) => p === "https")) {
      return "https";
    }
    if (parts.some((p) => p === "http")) {
      return "http";
    }
  }
  const p = String(req.protocol || "http")
    .split(",")[0]!
    .trim()
    .toLowerCase()
    .replace(/:$/, "");
  return p === "https" ? "https" : "http";
}

function isLocalOauthHost(host: string): boolean {
  const h = host.toLowerCase().split(":")[0] ?? "";
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "0.0.0.0"
  );
}

/**
 * Origem pública (scheme + host) para OAuth / PRM: alinha com o URL que o cliente usa no Cursor.
 * Sem X-Forwarded-Proto, o Node vê só http; em hosts públicos força https por defeito (evita
 * "Protected resource http://… does not match expected https://…"). Override: MCP_HUB_OAUTH_PUBLIC_ORIGIN.
 * Desactivar coerção: MCP_HUB_OAUTH_COERCE_HTTPS=0
 */
function oauthPublicOrigin(req: Request): string {
  const originOverride = process.env.MCP_HUB_OAUTH_PUBLIC_ORIGIN?.trim();
  if (originOverride) {
    return originOverride.replace(/\/$/, "");
  }
  const rawHost =
    req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const host = rawHost.split(",")[0]!.trim();
  let scheme = inferPublicHttpScheme(req);
  const coerceEnv = process.env.MCP_HUB_OAUTH_COERCE_HTTPS?.trim().toLowerCase();
  const coerceHttps =
    coerceEnv === undefined ||
    coerceEnv === "" ||
    coerceEnv === "1" ||
    coerceEnv === "true";
  if (coerceHttps && scheme === "http" && !isLocalOauthHost(host)) {
    scheme = "https";
  }
  return `${scheme}://${host}`;
}

/** Falha com lista completa: variáveis em falta por servidor (chaves WMS/TAR vêem ESHIP_API_KEY_WMS / _TAR). */
function assertEnvPlaceholdersForConfig(
  config: HubConfig,
  baseEnv: EnvLookup,
  extraByServer?: Record<string, EnvLookup>,
): void {
  const varToServers = new Map<string, Set<string>>();
  for (const [serverKey, def] of Object.entries(config.mcpServers)) {
    const envK: EnvLookup = {
      ...effectiveEnvForUpstream(baseEnv, serverKey),
      ...(extraByServer?.[serverKey] ?? {}),
    };
    const blobs: string[] =
      "streamableHttp" in def
        ? [
            def.streamableHttp.url,
            ...Object.values(def.streamableHttp.headers ?? {}),
          ]
        : [
            def.command,
            ...(def.args ?? []),
            ...Object.values(def.env ?? {}),
            ...(def.cwd ? [def.cwd] : []),
          ];
    const names = new Set<string>();
    for (const b of blobs) {
      for (const n of envVarNamesInString(b)) {
        names.add(n);
      }
    }
    for (const n of names) {
      if (getEnvValue(envK, n) === undefined) {
        let set = varToServers.get(n);
        if (!set) {
          set = new Set();
          varToServers.set(n, set);
        }
        set.add(serverKey);
      }
    }
  }
  if (varToServers.size === 0) {
    return;
  }
  const missing = [...varToServers.entries()].map(([name, servers]) => ({
    name,
    servers: [...servers].sort(),
  }));
  const blocks = missing.map(
    (m) =>
      `  • ${m.name}\n    servidores: ${m.servers.join(", ")} (${m.servers.length})`,
  );
  throw new Error(
    [
      "Faltam valores para expandir placeholders no mcp-hub.config.json:",
      ...blocks,
      "",
      "Modo HTTP: URL base (X-Eship-Api-Base-Url / X-Api-Base-Url ou _meta).",
      "Chaves: X-Eship-Api-Key, ou só WMS: X-Eship-Api-Key-WMS (ou API-WMS), só TAR: X-Eship-Api-Key-TAR (ou APIKEY-TAR), ambos módulos: X-Eship-Api-Key-WMS + X-Eship-Api-Key-TAR.",
      "Modo stdio: ESHIP_API_KEY_WMS / ESHIP_API_KEY_TAR / ESHIP_* no env do processo.",
    ].join("\n"),
  );
}

function expandEnvPlaceholders(value: string, env: EnvLookup): string {
  return value.replace(
    new RegExp(ENV_VAR_REF.source, "g"),
    (_match, name: string) => {
      const v = getEnvValue(env, name);
      if (v === undefined) {
        throw new Error(
          `Variável ausente ou vazia: ${name}. Em HTTP usa cabeçalhos ou initialize.params._meta; em stdio usa mcp.json → env.`,
        );
      }
      return v;
    },
  );
}

function mergeConnectionIntoServerDef(
  def: ServerDef,
  connection: HubConnectionOverrides | undefined,
): ServerDef {
  if (!connection) {
    return def;
  }
  const has =
    (connection.headers && Object.keys(connection.headers).length > 0) ||
    (connection.env && Object.keys(connection.env).length > 0) ||
    Boolean(connection.url?.trim());
  if (!has) {
    return def;
  }
  if ("streamableHttp" in def) {
    const url = connection.url?.trim() || def.streamableHttp.url;
    const headers = {
      ...(def.streamableHttp.headers ?? {}),
      ...(connection.headers ?? {}),
    };
    return {
      streamableHttp: {
        url,
        headers: Object.keys(headers).length ? headers : undefined,
      },
    };
  }
  return {
    command: def.command,
    args: def.args,
    cwd: def.cwd,
    env: { ...(def.env ?? {}), ...(connection.env ?? {}) },
  };
}

/** Chave estável por token+MCP (nomes de tools no hub). */
export function syntheticMcpServerKey(tokenId: string, mcpId: string): string {
  const a = tokenId.replace(/-/g, "").slice(0, 8);
  const b = mcpId.replace(/-/g, "").slice(0, 12);
  return `t${a}_${b}`;
}

/** Chave injectada no `mcpServers` para definições em `mcp_templates` (registo). */
export function hubTemplateInjectKey(templateDocId: string): string {
  return `__hub_template__${templateDocId}`;
}

/**
 * Constrói `mcpServers` a partir dos `token_mcps`: URL directa (streamableHttp),
 * catálogo global (`templateServerKey` + `connection`) ou template admin (`templateId` + `connection`).
 */
export function buildHubConfigForApiToken(
  hubCfgBase: HubConfig,
  mcps: TokenMcpRecord[],
  tokenId: string,
): {
  hubCfg: HubConfig;
  extraEnvByServer: Record<string, EnvLookup>;
} {
  if (mcps.length === 0) {
    throw new Error(
      "Este token de API não tem MCPs configurados (adiciona entradas no painel admin).",
    );
  }
  const mcpServers: Record<string, ServerDef> = {};
  const extraEnvByServer: Record<string, EnvLookup> = {};

  for (const m of mcps) {
    const key = syntheticMcpServerKey(tokenId, m.id);
    const url = m.url?.trim();
    const tpl = m.templateServerKey?.trim();
    const tid = m.templateId?.trim();
    const modeCount = [Boolean(url), Boolean(tpl), Boolean(tid)].filter(Boolean)
      .length;
    if (modeCount !== 1) {
      throw new Error(
        "Cada MCP tem de ser exactamente um modo: url directa, templateServerKey (catálogo) ou templateId (template admin).",
      );
    }
    if (url) {
      const headers = { ...(m.headers ?? {}) };
      mcpServers[key] = {
        streamableHttp: {
          url,
          headers: Object.keys(headers).length ? headers : undefined,
        },
      };
    } else if (tpl) {
      const baseDef = hubCfgBase.mcpServers[tpl];
      if (!baseDef) {
        throw new Error(
          `Servidor MCP de catálogo "${tpl}" não existe nesta sessão (módulo WMS/TAR ou chave inexistente).`,
        );
      }
      mcpServers[key] = mergeConnectionIntoServerDef(baseDef, m.connection);
    } else {
      const inj = hubTemplateInjectKey(tid!);
      const baseDef = hubCfgBase.mcpServers[inj];
      if (!baseDef) {
        throw new Error(
          `Template administrativo "${tid}" não existe ou foi removido do registo.`,
        );
      }
      mcpServers[key] = mergeConnectionIntoServerDef(baseDef, m.connection);
    }
    extraEnvByServer[key] = {
      ...(m.env ?? {}),
      ...(m.connection?.env ?? {}),
    };
  }
  return { hubCfg: { mcpServers }, extraEnvByServer };
}

function expandServerDef(def: ServerDef, env: EnvLookup): ServerDef {
  if ("streamableHttp" in def) {
    const h = def.streamableHttp.headers;
    return {
      streamableHttp: {
        url: expandEnvPlaceholders(def.streamableHttp.url, env),
        headers: h
          ? Object.fromEntries(
              Object.entries(h).map(([k, v]) => [
                k,
                expandEnvPlaceholders(v, env),
              ]),
            )
          : undefined,
      },
    };
  }
  return {
    command: expandEnvPlaceholders(def.command, env),
    args: (def.args ?? []).map((a) => expandEnvPlaceholders(a, env)),
    env: def.env
      ? Object.fromEntries(
          Object.entries(def.env).map(([k, v]) => [
            k,
            expandEnvPlaceholders(v, env),
          ]),
        )
      : undefined,
    cwd: def.cwd ? expandEnvPlaceholders(def.cwd, env) : undefined,
  };
}

/**
 * Alguns endpoints e-ship respondem 400 ao GET SSE; o SDK só ignora 405 ("sem stream GET").
 * Converter esse caso evita erros do mcp-remote e mantém o cliente só com POST + SSE na resposta.
 */
function wrapFetchForStreamableMcpSseGet400As405(
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    let method = init?.method;
    if (!method && typeof input === "object" && input instanceof Request) {
      method = input.method;
    }
    method = (method ?? "GET").toUpperCase();
    const hdrInit = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const accept = hdrInit
      ? new Headers(hdrInit as HeadersInit).get("accept") ?? ""
      : "";
    if (
      method === "GET" &&
      accept.includes("text/event-stream") &&
      res.status === 400
    ) {
      await res.body?.cancel().catch(() => {});
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      });
    }
    return res;
  };
}

function headerOne(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string" || !s.trim()) {
    return undefined;
  }
  return s.trim();
}

type SessionCredentials = {
  sessionEnv: EnvLookup;
  /** Se definido, só ligam upstreams cujo nome em config começa por eship-wms- ou eship-tar-. */
  moduleTag: HubModuleTag | null;
};

/** Módulo efectivo após cabeçalhos + _meta (WMS/TAR com chaves separadas ou API-WMS / APIKEY-TAR). */
function finalizeSessionModuleTag(
  out: EnvLookup,
  apiWmsHdr: string | undefined,
  apiTarHdr: string | undefined,
  metaModule: HubModuleTag | null,
): HubModuleTag | null {
  const w = getEnvValue(out, "ESHIP_API_KEY_WMS");
  const t = getEnvValue(out, "ESHIP_API_KEY_TAR");
  if (apiWmsHdr && apiTarHdr) {
    throw new Error(
      "Não envies API-WMS e APIKEY-TAR no mesmo pedido; usa um módulo por sessão.",
    );
  }
  if (w && t) {
    if (apiWmsHdr || apiTarHdr) {
      throw new Error(
        "Com X-Eship-Api-Key-WMS e X-Eship-Api-Key-TAR não uses API-WMS / APIKEY-TAR.",
      );
    }
    if (metaModule !== null) {
      throw new Error(
        "Com chaves WMS e TAR no pedido, omite params._meta.hubModule (sessão já inclui os dois módulos).",
      );
    }
    return null;
  }
  let fromKeys: HubModuleTag | null = null;
  if (w) {
    if (apiTarHdr) {
      throw new Error(
        "X-Eship-Api-Key-WMS não combina com o cabeçalho APIKEY-TAR.",
      );
    }
    fromKeys = "wms";
  } else if (t) {
    if (apiWmsHdr) {
      throw new Error(
        "X-Eship-Api-Key-TAR não combina com o cabeçalho API-WMS.",
      );
    }
    fromKeys = "tar";
  } else {
    if (apiWmsHdr) {
      fromKeys = "wms";
    } else if (apiTarHdr) {
      fromKeys = "tar";
    }
  }
  if (metaModule !== null && fromKeys !== null && metaModule !== fromKeys) {
    throw new Error(
      "params._meta.hubModule (ou module) não coincide com X-Eship-Api-Key-WMS / TAR nem com API-WMS / APIKEY-TAR.",
    );
  }
  return metaModule ?? fromKeys;
}

/** Ambiente para expandir placeholders: process.env + credenciais do pedido initialize (HTTP). */
function mergeSessionEnv(req: Request, initBody: unknown): SessionCredentials {
  const out: EnvLookup = { ...process.env };
  let metaModule: HubModuleTag | null = null;

  const hk = headerOne(req, "x-eship-api-key");
  const hApiKey = headerOne(req, "x-api-key");
  const hb = headerOne(req, "x-eship-api-base-url");
  const hBase = headerOne(req, "x-api-base-url");
  const hWmsKey = headerOne(req, "x-eship-api-key-wms");
  const hTarKey = headerOne(req, "x-eship-api-key-tar");
  const hWms = headerOne(req, "api-wms");
  const hTar = headerOne(req, "apikey-tar");

  if (hWmsKey) {
    out.ESHIP_API_KEY_WMS = hWmsKey;
  }
  if (hTarKey) {
    out.ESHIP_API_KEY_TAR = hTarKey;
  }

  if (hk) {
    out.ESHIP_API_KEY = hk;
  } else if (!(hWmsKey || hTarKey) && hWms) {
    out.ESHIP_API_KEY = hWms;
  } else if (!(hWmsKey || hTarKey) && hTar) {
    out.ESHIP_API_KEY = hTar;
  } else if (hApiKey) {
    out.ESHIP_API_KEY = hApiKey;
  }
  if (hb) {
    out.ESHIP_API_BASE_URL = hb;
  } else if (hBase) {
    out.ESHIP_API_BASE_URL = hBase;
  }
  if (isInitializeRequest(initBody)) {
    const params = initBody.params as Record<string, unknown> | undefined;
    const meta = params?._meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      const rawMod = m.hubModule ?? m.module;
      if (typeof rawMod === "string" && rawMod.trim()) {
        const norm = rawMod.trim().toLowerCase();
        if (norm === "wms" || norm === "tar") {
          metaModule = norm === "wms" ? "wms" : "tar";
        }
      }
      const mWms =
        m.eshipApiKeyWms ??
        m.ESHIP_API_KEY_WMS ??
        m.apiWms ??
        m.API_WMS;
      if (typeof mWms === "string" && mWms.trim()) {
        out.ESHIP_API_KEY_WMS = mWms.trim();
      }
      const mTarM =
        m.eshipApiKeyTar ??
        m.ESHIP_API_KEY_TAR ??
        m.apikeyTar ??
        m.APIKEY_TAR;
      if (typeof mTarM === "string" && mTarM.trim()) {
        out.ESHIP_API_KEY_TAR = mTarM.trim();
      }
      const k =
        m.eshipApiKey ?? m.ESHIP_API_KEY ?? m["eship/apiKey"];
      const u =
        m.eshipApiBaseUrl ??
        m.ESHIP_API_BASE_URL ??
        m["eship/apiBaseUrl"] ??
        m.apiBaseUrl ??
        m.API_BASE_URL;
      if (typeof k === "string" && k.trim()) {
        out.ESHIP_API_KEY = k.trim();
      }
      if (typeof u === "string" && u.trim()) {
        out.ESHIP_API_BASE_URL = u.trim();
      }
    }
  }
  const moduleTag = finalizeSessionModuleTag(out, hWms, hTar, metaModule);
  assertEshipApiBaseUrlUsesHttpOrHttps(out);
  return { sessionEnv: out, moduleTag };
}

type ResolvedHubConfig =
  | { ok: true; hubCfg: HubConfig; extraEnvByServer?: Record<string, EnvLookup> }
  | { ok: false; httpStatus: number; message: string };

async function resolveHubConfigForHttpSession(
  req: Request,
  fullConfig: HubConfig,
  moduleTag: HubModuleTag | null,
  store: HubUserStore,
): Promise<ResolvedHubConfig> {
  const tokenHdr = headerOne(req, "x-mcp-hub-user-token");
  if (!tokenHdr) {
    const hubCfgBase = sessionHubConfig(fullConfig, moduleTag);
    return { ok: true, hubCfg: hubCfgBase };
  }
  await store.load();
  const apiToken = store.getApiTokenBySecret(tokenHdr);
  if (!apiToken) {
    return {
      ok: false,
      httpStatus: 401,
      message: "X-MCP-Hub-User-Token inválido ou revogado.",
    };
  }
  const mcps = store.mcpsForToken(apiToken.id);
  const usesCatalogTemplate = mcps.some((m) =>
    Boolean(m.templateServerKey?.trim()),
  );
  const moduleForCatalog =
    usesCatalogTemplate || mcps.length === 0 ? moduleTag : null;
  const hubCfgFiltered = sessionHubConfig(fullConfig, moduleForCatalog);
  const tplFrag = await loadRegistryTemplatesHubFragment();
  const hubCfgBase: HubConfig = {
    mcpServers: { ...hubCfgFiltered.mcpServers, ...tplFrag.mcpServers },
  };
  try {
    const { hubCfg, extraEnvByServer } = buildHubConfigForApiToken(
      hubCfgBase,
      mcps,
      apiToken.id,
    );
    return { ok: true, hubCfg, extraEnvByServer };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, httpStatus: 400, message: msg };
  }
}

function log(...args: unknown[]) {
  console.error("[mcp-hub]", ...args);
}

function hubToolName(serverKey: string, upstreamName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe(serverKey)}__${safe(upstreamName)}`;
}

async function loadFileHubConfig(): Promise<HubConfig> {
  const path =
    process.env.MCP_HUB_CONFIG ??
    resolve(process.cwd(), "mcp-hub.config.json");
  const raw = await readFile(path, "utf8");
  const json: unknown = JSON.parse(raw);
  return HubConfigSchema.parse(json);
}

/** Ficheiro mcp-hub.config.json + documentos na coleção `mcp_servers` (JSON NoSQL em disco). */
async function loadMergedHubConfig(): Promise<HubConfig> {
  const fileCfg = await loadFileHubConfig();
  const docs = await getMcpRegistryStore().list();
  const merged = { ...fileCfg.mcpServers };
  for (const d of docs) {
    merged[d.key] = HubServerDefSchema.parse(d.def);
  }
  return { mcpServers: merged };
}

/** Fragmento a fundir na config da sessão: templates admin (`mcp_templates`). */
async function loadRegistryTemplatesHubFragment(): Promise<HubConfig> {
  const templates = await getMcpRegistryStore().listTemplates();
  const mcpServers: Record<string, ServerDef> = {};
  for (const t of templates) {
    mcpServers[hubTemplateInjectKey(t._id)] = HubServerDefSchema.parse(t.def);
  }
  return { mcpServers };
}

async function listAllTools(client: Client) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Fila global: vários clientes HTTP partilham os mesmos processos upstream (stdio). */
function createCallSerializer() {
  let chain: Promise<unknown> = Promise.resolve();
  return function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export function buildHubMcpServer(upstreams: Upstream[]): McpServer {
  const serialize = createCallSerializer();

  const routing = new Map<
    string,
    { upstream: Client; originalName: string; serverKey: string }
  >();

  for (const u of upstreams) {
    for (const [exposed, original] of u.tools) {
      routing.set(exposed, {
        upstream: u.client,
        originalName: original,
        serverKey: u.key,
      });
    }
  }

  const hub = new McpServer(
    { name: "mcp-hub", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
      },
      instructions: [
        "Este hub expõe apenas ferramentas (Tools) agregadas de vários servidores MCP.",
        "Não há prompts nem resources neste hub — no Cursor só a secção Tools mostrará entradas.",
        "Cada nome é prefixado como SERVIDOR__ferramenta. Usa mcp_hub__meta para o mapa completo.",
        "e-ship (HTTP): X-Eship-Api-Key-WMS / X-Eship-Api-Key-TAR (chaves por módulo) ou X-Eship-Api-Key; URL base X-Eship-Api-Base-Url / X-Api-Base-Url. API-WMS/APIKEY-TAR = só um módulo. _meta: eshipApiKeyWms, eshipApiKeyTar, eshipApiBaseUrl. stdio: env.",
        "X-MCP-Hub-User-Token: secret de API token (painel admin); MCPs só por URL directa ignoram o filtro WMS/TAR.",
      ].join("\n"),
    },
  );

  hub.registerTool(
    "mcp_hub__meta",
    {
      description:
        "Lista servidores conectados e o mapeamento nome do hub → ferramenta original no upstream.",
    },
    async () => {
      const lines: string[] = [];
      for (const u of upstreams) {
        lines.push(`## ${u.key}`);
        for (const [exposed, orig] of u.tools) {
          lines.push(`- \`${exposed}\` → \`${orig}\``);
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  for (const [hubName, { upstream, originalName, serverKey }] of routing) {
    hub.registerTool(
      hubName,
      {
        title: hubName,
        description: `[${serverKey}] → ${originalName} (argumentos repassados; veja documentação do servidor original).`,
        inputSchema: passthroughArgs,
      },
      async (args) => {
        return serialize(async () => {
          const result = await upstream.callTool({
            name: originalName,
            arguments: (args as Record<string, unknown>) ?? {},
          });
          if ("content" in result && Array.isArray(result.content)) {
            return result as CallToolResult;
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          } satisfies CallToolResult;
        });
      },
    );
  }

  return hub;
}

export async function connectAllUpstreams(
  config: HubConfig,
  env: EnvLookup,
  extraEnvByServer?: Record<string, EnvLookup>,
): Promise<Upstream[]> {
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) {
    throw new Error("mcpServers está vazio.");
  }

  const upstreams: Upstream[] = [];

  for (const [key, rawDef] of entries) {
    let def: ServerDef;
    try {
      const mergedEnv: EnvLookup = {
        ...effectiveEnvForUpstream(env, key),
        ...(extraEnvByServer?.[key] ?? {}),
      };
      def = expandServerDef(rawDef, mergedEnv);
    } catch (e: unknown) {
      log(`Upstream "${key}": expansão de variáveis falhou:`, e);
      for (const u of upstreams) {
        await u.client.close().catch(() => {});
        await u.transport.close().catch(() => {});
      }
      throw e;
    }

    const client = new Client(
      { name: `mcp-hub-upstream:${key}`, version: "1.0.0" },
      { capabilities: {} },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if ("streamableHttp" in def) {
      const fetchWrap = wrapFetchForStreamableMcpSseGet400As405(
        globalThis.fetch.bind(globalThis),
      );
      const headers = def.streamableHttp.headers ?? {};
      transport = new StreamableHTTPClientTransport(
        new URL(def.streamableHttp.url),
        {
          requestInit: { headers },
          fetch: fetchWrap,
        },
      );
    } else {
      const baseEnv = getDefaultEnvironment();
      const childEnv: Record<string, string> = {
        ...baseEnv,
        ...(def.env ?? {}),
      };
      transport = new StdioClientTransport({
        command: def.command,
        args: def.args ?? [],
        env: childEnv,
        cwd: def.cwd,
        stderr: "inherit",
      });
    }

    try {
      await client.connect(transport);
    } catch (e) {
      log(`Upstream "${key}" não conectou:`, e);
      await transport.close().catch(() => {});
      for (const u of upstreams) {
        await u.client.close().catch(() => {});
        await u.transport.close().catch(() => {});
      }
      throw e;
    }

    const toolList = await listAllTools(client);
    const tools = new Map<string, string>();
    for (const t of toolList) {
      tools.set(hubToolName(key, t.name), t.name);
    }
    upstreams.push({ key, client, transport, tools });
    log(`Conectado "${key}": ${toolList.length} ferramenta(s).`);
  }

  return upstreams;
}

async function serveStdio(upstreams: Upstream[]) {
  const hub = buildHubMcpServer(upstreams);
  const transport = new StdioServerTransport();
  await hub.connect(transport);
  hub.sendToolListChanged();

  const shutdown = async () => {
    for (const u of upstreams) {
      await u.client.close().catch(() => {});
      await u.transport.close().catch(() => {});
    }
    await hub.close().catch(() => {});
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

type HttpSession = {
  transport: StreamableHTTPServerTransport;
  hub: McpServer;
  upstreams: Upstream[];
};

type SseSessionBundle = {
  transport: SSEServerTransport;
  hub: McpServer;
  upstreams: Upstream[];
};

async function serveHttp() {
  const port = Number(process.env.MCP_HUB_HTTP_PORT ?? "3343");
  /** 0.0.0.0 = aceita ligações de qualquer IP na máquina (porta aberta no firewall). */
  const httpHost =
    process.env.MCP_HUB_HTTP_HOST?.trim() || "0.0.0.0";
  const basePath = (process.env.MCP_HUB_HTTP_PATH ?? "/mcp").replace(/\/$/, "") || "/mcp";
  const allowedHostsEnv = process.env.MCP_HUB_ALLOWED_HOSTS;

  const expressOpts =
    allowedHostsEnv !== undefined && allowedHostsEnv.trim() !== ""
      ? {
          host: httpHost,
          allowedHosts: allowedHostsEnv.split(",").map((h) => h.trim()),
        }
      : { host: httpHost };

  const app = createMcpExpressApp(expressOpts);

  const trustProxy = process.env.MCP_HUB_TRUST_PROXY?.trim().toLowerCase();
  if (trustProxy === "1" || trustProxy === "true" || trustProxy === "yes") {
    app.set("trust proxy", 1);
  }

  const hubUserStore = new HubUserStore();
  const adminPassword = process.env.MCP_HUB_ADMIN_PASSWORD?.trim();
  const adminSessionSecret =
    process.env.MCP_HUB_ADMIN_SECRET?.trim() || adminPassword;
  const hubAdminEnabled = Boolean(adminPassword && adminSessionSecret);
  await hubUserStore.load().catch(() => undefined);
  app.use(
    "/hub-admin",
    createHubAdminRouter({
      hubAdminEnabled,
      store: hubUserStore,
      registry: getMcpRegistryStore(),
      adminPassword: adminPassword ?? "",
      sessionSecret: adminSessionSecret ?? "",
      getMergedServerKeys: async () =>
        Object.keys((await loadMergedHubConfig()).mcpServers).sort(),
      parseServerDef: (v: unknown) => HubServerDefSchema.parse(v),
      mcpHttpPath: basePath,
    }),
  );
  const adminHost = httpHost === "0.0.0.0" ? "127.0.0.1" : httpHost;
  if (hubAdminEnabled) {
    log(`Admin activo: http://${adminHost}:${port}/hub-admin`);
  } else {
    log(
      `Admin em modo informativo (sem login): http://${adminHost}:${port}/hub-admin — defina MCP_HUB_ADMIN_PASSWORD para activar.`,
    );
  }

  const oauthAuthCodeStub = "mcp-hub-oauth-stub";
  const oauthRefreshStub = "mcp-hub-refresh-stub";
  const oauthAccessStub =
    process.env.MCP_HUB_OAUTH_STUB_ACCESS_TOKEN?.trim() || "mcp-hub-oauth-access-stub";

  // Cursor / MCP V2: descoberta OAuth (RFC 9728 + 8414) + DCR + código de autorização.
  // Facade mínima para o cliente concluir o fluxo sem IdP real; credenciais e-ship continuam nos cabeçalhos / initialize.
  app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (req: Request, res: Response) => {
    const resourceOverride = process.env.MCP_HUB_OAUTH_RESOURCE_URL?.trim();
    const origin = oauthPublicOrigin(req);
    const resource = resourceOverride
      ? resourceOverride.replace(/\/$/, "")
      : `${origin}${basePath}`.replace(/\/$/, "");
    res.type("application/json").json({
      resource,
      authorization_servers: [`${origin}/`],
      scopes_supported: ["mcp"],
    });
  });

  const authorizationServerMetadata = (req: Request) => {
    const origin = oauthPublicOrigin(req);
    const issuer = `${origin}/`;
    return {
      issuer,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
      ],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "mcp"],
    };
  };

  app.get(/^\/\.well-known\/oauth-authorization-server(\/.*)?$/, (req: Request, res: Response) => {
    res.type("application/json").json(authorizationServerMetadata(req));
  });

  app.post("/register", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let redirectUris: string[] = [];
    if (Array.isArray(body.redirect_uris)) {
      redirectUris = (body.redirect_uris as unknown[]).filter(
        (x): x is string => typeof x === "string",
      );
    }
    let validUris = redirectUris.filter((u) => {
      try {
        const x = new URL(u);
        return x.protocol === "http:" || x.protocol === "https:";
      } catch {
        return false;
      }
    });
    if (validUris.length === 0) {
      validUris = ["http://127.0.0.1/oauth/callback"];
    }
    res.status(201).type("application/json").json({
      client_id: `mcp-hub-${randomUUID()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: validUris,
      token_endpoint_auth_method: "none",
      grant_types: Array.isArray(body.grant_types)
        ? body.grant_types.filter((g): g is string => typeof g === "string")
        : ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const redirectUri = String(req.query.redirect_uri ?? "");
    const state = String(req.query.state ?? "");
    try {
      const target = new URL(redirectUri);
      const proto = target.protocol;
      if (
        proto !== "http:" &&
        proto !== "https:" &&
        proto !== "cursor:" &&
        proto !== "vscode:"
      ) {
        throw new Error("scheme");
      }
      target.searchParams.set("code", oauthAuthCodeStub);
      if (state) {
        target.searchParams.set("state", state);
      }
      res.redirect(302, target.toString());
    } catch {
      res.status(400).type("application/json").json({
        error: "invalid_request",
        error_description: "redirect_uri inválido ou em falta.",
      });
    }
  });

  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const p = req.body as Record<string, string | undefined>;
      const grant = p.grant_type;
      if (grant === "authorization_code" && p.code === oauthAuthCodeStub) {
        res.type("application/json").json({
          access_token: oauthAccessStub,
          token_type: "Bearer",
          expires_in: 86_400,
          refresh_token: oauthRefreshStub,
        });
        return;
      }
      if (grant === "refresh_token" && p.refresh_token === oauthRefreshStub) {
        res.type("application/json").json({
          access_token: oauthAccessStub,
          token_type: "Bearer",
          expires_in: 86_400,
        });
        return;
      }
      if (grant === "client_credentials") {
        res.type("application/json").json({
          access_token: oauthAccessStub,
          token_type: "Bearer",
          expires_in: 86_400,
        });
        return;
      }
      res.status(400).type("application/json").json({
        error: "unsupported_grant_type",
        error_description:
          "Este hub só aceita o fluxo de teste authorization_code (código fixo), refresh_token ou client_credentials.",
      });
    },
  );

  app.get(`${basePath}/health`, (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "mcp-hub",
      transport: "streamable-http",
      hubAdmin: "/hub-admin",
      hubAdminLoginEnabled: hubAdminEnabled,
      mcpRegistry:
        "Registo NoSQL em disco (mcp_servers + mcp_templates): MCP_HUB_MCP_REGISTRY_FILE; mescla servidores com mcp-hub.config.json.",
      hubUserToken:
        "Opcional: cabeçalho X-MCP-Hub-User-Token = secret de um API token (vários por utilizador na UI admin). Só MCPs directos por URL: o filtro de módulo WMS/TAR não se aplica a esse token.",
      eshipAuth:
        "initialize: chave + URL base http(s). Proxy: MCP_HUB_TRUST_PROXY=1. OAuth PRM: MCP_HUB_OAUTH_PUBLIC_ORIGIN / MCP_HUB_OAUTH_RESOURCE_URL; MCP_HUB_OAUTH_COERCE_HTTPS=0 em dev só-http.",
      sseLegacy: `GET ${basePath} com Accept: text/event-stream + POST ${basePath}/messages?sessionId=… (clientes com fallback SSE).`,
    });
  });

  const streamableTransports: Record<string, StreamableHTTPServerTransport> =
    {};
  const sessions = new Map<string, HttpSession>();
  const sseBundles = new Map<string, SseSessionBundle>();

  async function disposeSseSession(sessionId: string) {
    const b = sseBundles.get(sessionId);
    if (!b) {
      return;
    }
    sseBundles.delete(sessionId);
    await b.transport.close().catch(() => {});
    await b.hub.close().catch(() => {});
    for (const u of b.upstreams) {
      await u.client.close().catch(() => {});
      await u.transport.close().catch(() => {});
    }
  }

  async function disposeSession(sid: string) {
    const s = sessions.get(sid);
    if (!s) {
      return;
    }
    sessions.delete(sid);
    delete streamableTransports[sid];
    await s.hub.close().catch(() => {});
    for (const u of s.upstreams) {
      await u.client.close().catch(() => {});
      await u.transport.close().catch(() => {});
    }
  }

  const mcpPost = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const rpcId = (() => {
      const b = req.body as { id?: unknown } | null | undefined;
      return b && typeof b === "object" && "id" in b ? b.id : null;
    })();
    try {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && streamableTransports[sessionId]) {
        transport = streamableTransports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        let sessionEnv: EnvLookup;
        let moduleTag: HubModuleTag | null;
        try {
          ({ sessionEnv, moduleTag } = mergeSessionEnv(req, req.body));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log("initialize: credenciais / módulo inválidos:", e);
          if (!res.headersSent) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32_602,
                message: msg,
              },
              id: rpcId,
            });
          }
          return;
        }
        const hubConfigMerged = await loadMergedHubConfig();
        const resolvedCfg = await resolveHubConfigForHttpSession(
          req,
          hubConfigMerged,
          moduleTag,
          hubUserStore,
        );
        if (!resolvedCfg.ok) {
          if (!res.headersSent) {
            res.status(resolvedCfg.httpStatus).json({
              jsonrpc: "2.0",
              error: {
                code:
                  resolvedCfg.httpStatus === 401 ? -32_601 : -32_602,
                message: resolvedCfg.message,
              },
              id: rpcId,
            });
          }
          return;
        }
        const { hubCfg, extraEnvByServer } = resolvedCfg;
        let upstreams: Upstream[];
        try {
          assertEnvPlaceholdersForConfig(
            hubCfg,
            sessionEnv,
            extraEnvByServer,
          );
          upstreams = await connectAllUpstreams(
            hubCfg,
            sessionEnv,
            extraEnvByServer,
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log("initialize: env / credenciais e-ship incompletos:", e);
          if (!res.headersSent) {
            res.status(401).json({
              jsonrpc: "2.0",
              error: {
                code: -32_001,
                message: msg,
              },
              id: rpcId,
            });
          }
          return;
        }
        const hub = buildHubMcpServer(upstreams);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            streamableTransports[sid] = transport;
            sessions.set(sid, { transport, hub, upstreams });
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            void disposeSession(sid);
          }
        };
        try {
          await hub.connect(transport);
          res.on("close", () => {
            void transport.close();
          });
          await transport.handleRequest(req, res, req.body);
          // Ferramentas são registadas antes do connect; sem isto alguns clientes (ex. Cursor)
          // não voltam a pedir tools/list após listChanged na capability.
          hub.sendToolListChanged();
        } catch (initErr) {
          log("Falha durante initialize / handleRequest:", initErr);
          const sidEarly = transport.sessionId;
          if (sidEarly) {
            delete streamableTransports[sidEarly];
            sessions.delete(sidEarly);
          }
          await hub.close().catch(() => {});
          for (const u of upstreams) {
            await u.client.close().catch(() => {});
            await u.transport.close().catch(() => {});
          }
          throw initErr;
        }
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32_000,
            message: "Pedido inválido: falta mcp-session-id ou não é initialize.",
          },
          id: rpcId,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log("Erro MCP POST:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32_603, message: "Internal server error" },
          id: rpcId,
        });
      }
    }
  };

  const mcpGet = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const accept = String(req.headers.accept ?? "");

    if (sessionId && streamableTransports[sessionId]) {
      try {
        await streamableTransports[sessionId].handleRequest(req, res);
      } catch (e) {
        log("Erro MCP GET (streamable):", e);
        if (!res.headersSent) {
          res.status(500).send("Error");
        }
      }
      return;
    }

    if (
      !sessionId &&
      req.method === "GET" &&
      accept.includes("text/event-stream")
    ) {
      let sessionEnv: EnvLookup;
      let moduleTag: HubModuleTag | null;
      try {
        ({ sessionEnv, moduleTag } = mergeSessionEnv(req, undefined));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("SSE legado GET: cabeçalhos de módulo inválidos:", e);
        if (!res.headersSent) {
          res.status(400).type("text/plain").send(msg);
        }
        return;
      }
      const hubConfigMergedSse = await loadMergedHubConfig();
      const resolvedSse = await resolveHubConfigForHttpSession(
        req,
        hubConfigMergedSse,
        moduleTag,
        hubUserStore,
      );
      if (!resolvedSse.ok) {
        if (!res.headersSent) {
          res
            .status(resolvedSse.httpStatus)
            .type("text/plain")
            .send(resolvedSse.message);
        }
        return;
      }
      const { hubCfg: hubCfgSse, extraEnvByServer: extraSse } = resolvedSse;
      let upstreams: Upstream[];
      try {
        assertEnvPlaceholdersForConfig(
          hubCfgSse,
          sessionEnv,
          extraSse,
        );
        upstreams = await connectAllUpstreams(
          hubCfgSse,
          sessionEnv,
          extraSse,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log("SSE legado GET: credenciais e-ship incompletas:", e);
        if (!res.headersSent) {
          res.status(401).type("text/plain").send(msg);
        }
        return;
      }
      const hub = buildHubMcpServer(upstreams);
      const sseT = new SSEServerTransport(`${basePath}/messages`, res);
      const sid = sseT.sessionId;
      sseBundles.set(sid, { transport: sseT, hub, upstreams });
      sseT.onclose = () => {
        void disposeSseSession(sid);
      };
      res.on("close", () => {
        void disposeSseSession(sid);
      });
      try {
        await hub.connect(sseT);
        hub.sendToolListChanged();
      } catch (e) {
        log("Erro ao ligar hub SSE:", e);
        await disposeSseSession(sid);
        if (!res.headersSent) {
          res.status(500).send("SSE connect failed");
        }
      }
      return;
    }

    if (sessionId) {
      res.status(404).type("text/plain").send(
        "Sessão MCP desconhecida neste processo (expirou, foi encerrada, ou o pedido foi encaminhado para outra réplica sem afinidade de sessão). " +
          "Em balanceamento horizontal, use sticky sessions ou um único nó atrás do proxy.",
      );
      return;
    }

    res
      .status(400)
      .send(
        "Streamable HTTP: falta cabeçalho mcp-session-id. SSE legado: GET com Accept: text/event-stream.",
      );
  };

  const mcpDelete = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !streamableTransports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await streamableTransports[sessionId].handleRequest(req, res);
    } catch (e) {
      log("Erro MCP DELETE:", e);
      if (!res.headersSent) {
        res.status(500).send("Error");
      }
    }
  };

  app.post(
    `${basePath}/messages`,
    async (req: Request, res: Response) => {
      const sid = String(req.query.sessionId ?? "");
      const bundle = sseBundles.get(sid);
      if (!bundle) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32_000,
            message: "Sessão SSE não encontrada. Abre primeiro GET com Accept: text/event-stream.",
          },
          id: null,
        });
        return;
      }
      try {
        await bundle.transport.handlePostMessage(req, res, req.body);
      } catch (e) {
        log("Erro POST /messages (SSE):", e);
        if (!res.headersSent) {
          res.status(500).send("Error");
        }
      }
    },
  );

  app.post(basePath, mcpPost);
  app.get(basePath, mcpGet);
  app.delete(basePath, mcpDelete);

  const server = app.listen(port, httpHost, () => {
    log(
      `MCP em *:${port}${basePath} — Streamable HTTP + SSE legado (GET + /messages).`,
    );
    log(`Health: GET http://127.0.0.1:${port}${basePath}/health`);
  });

  const shutdown = async () => {
    for (const sid of [...sessions.keys()]) {
      await disposeSession(sid);
    }
    for (const sid of [...sseBundles.keys()]) {
      await disposeSseSession(sid);
    }
    for (const sid of Object.keys(streamableTransports)) {
      await streamableTransports[sid]?.close().catch(() => {});
      delete streamableTransports[sid];
    }
    await new Promise<void>((resolvePromise, reject) => {
      server.close((err: Error | undefined) =>
        err ? reject(err) : resolvePromise(),
      );
    });
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function main() {
  let config: HubConfig;
  try {
    config = await loadMergedHubConfig();
  } catch (e: unknown) {
    log("Falha ao carregar config:", e);
    log(
      "Defina MCP_HUB_CONFIG com caminho absoluto para o JSON ou crie mcp-hub.config.json na pasta de trabalho.",
    );
    process.exit(1);
  }

  const mode = (process.env.MCP_HUB_TRANSPORT ?? "stdio").toLowerCase();
  if (mode === "http" || mode === "streamable-http") {
    await serveHttp();
    return;
  }

  try {
    assertEshipApiBaseUrlUsesHttpOrHttps(process.env as EnvLookup);
    assertEnvPlaceholdersForConfig(config, process.env);
  } catch (e: unknown) {
    log(e);
    process.exit(1);
  }

  let upstreams: Upstream[];
  try {
    upstreams = await connectAllUpstreams(config, process.env);
  } catch (e: unknown) {
    log(e);
    process.exit(1);
  }

  await serveStdio(upstreams);
}

const hubEntry =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (hubEntry) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/** Sobrescritas por vínculo template (expandir ${VAR} com env do vínculo + pedido). */
export type HubConnectionOverrides = {
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

/** Utilizador (sem credencial — tokens em `api_tokens`). */
export type HubUser = {
  id: string;
  label: string;
  createdAt: string;
};

export type ApiTokenRecord = {
  id: string;
  userId: string;
  /** Etiqueta opcional (ex. CI, laptop). */
  label: string;
  secret: string;
  createdAt: string;
};

/**
 * MCP ligado a um token:
 * - URL directa (`url` + `headers`);
 * - catálogo global (`templateServerKey` + `connection`);
 * - template administrativo (`templateId` → documento em `mcp_templates`; o utilizador
 *   ajusta sobretudo `connection.headers` para credenciais).
 */
export type TokenMcpRecord = {
  id: string;
  tokenId: string;
  label?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  templateServerKey?: string;
  /** _id do documento `mcp_templates` no ficheiro do registo. */
  templateId?: string;
  connection?: HubConnectionOverrides;
  createdAt: string;
  updatedAt: string;
};

export type HubUsersFile = {
  schemaVersion: 2;
  users: HubUser[];
  api_tokens: ApiTokenRecord[];
  token_mcps: TokenMcpRecord[];
};

/** Formato legado v1 (migração). */
export type HubUserV1 = {
  id: string;
  label: string;
  apiToken: string;
  createdAt: string;
};

export type HubUserLinkRecordV1 = {
  id: string;
  userId: string;
  serverKey: string;
  connection: HubConnectionOverrides;
};

export type HubUsersFileV1 = {
  users: HubUserV1[];
  links: HubUserLinkRecordV1[];
};

/** Sobrescritas por vínculo utilizador ↔ MCP (expandir ${VAR} com env do vínculo + pedido). */
export type HubConnectionOverrides = {
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

export type HubUser = {
  id: string;
  label: string;
  apiToken: string;
  createdAt: string;
};

export type HubUserLinkRecord = {
  id: string;
  userId: string;
  serverKey: string;
  connection: HubConnectionOverrides;
};

export type HubUsersFile = {
  users: HubUser[];
  links: HubUserLinkRecord[];
};

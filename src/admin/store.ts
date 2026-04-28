import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApiTokenRecord,
  HubConnectionOverrides,
  HubUser,
  HubUsersFile,
  HubUsersFileV1,
  TokenMcpRecord,
} from "./types.js";

function emptyV2(): HubUsersFile {
  return { schemaVersion: 2, users: [], api_tokens: [], token_mcps: [] };
}

function isV2(parsed: unknown): parsed is HubUsersFile {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as HubUsersFile).schemaVersion === 2 &&
    Array.isArray((parsed as HubUsersFile).users) &&
    Array.isArray((parsed as HubUsersFile).api_tokens) &&
    Array.isArray((parsed as HubUsersFile).token_mcps)
  );
}

function isV1Shape(parsed: unknown): parsed is HubUsersFileV1 {
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion === 2) {
    return false;
  }
  if (!Array.isArray(p.users)) {
    return false;
  }
  const hasOldToken = (p.users as HubUsersFileV1["users"]).some(
    (u) => typeof u === "object" && u !== null && "apiToken" in u && typeof (u as { apiToken?: string }).apiToken === "string" && Boolean((u as { apiToken?: string }).apiToken?.trim()),
  );
  const hasLinks = Array.isArray(p.links);
  return hasOldToken || hasLinks;
}

/** Migração v1 → v2: um api_token por utilizador com apiToken; links → token_mcps com template. */
export function migrateV1ToV2(v1: HubUsersFileV1): HubUsersFile {
  const now = new Date().toISOString();
  const users: HubUser[] = [];
  const api_tokens: ApiTokenRecord[] = [];
  const token_mcps: TokenMcpRecord[] = [];

  for (const u of v1.users ?? []) {
    users.push({
      id: u.id,
      label: u.label,
      createdAt: u.createdAt,
    });
    const secret = typeof u.apiToken === "string" ? u.apiToken.trim() : "";
    if (!secret) {
      continue;
    }
    const tid = randomUUID();
    api_tokens.push({
      id: tid,
      userId: u.id,
      label: "default",
      secret,
      createdAt: u.createdAt,
    });
    for (const l of (v1.links ?? []).filter((x) => x.userId === u.id)) {
      token_mcps.push({
        id: randomUUID(),
        tokenId: tid,
        label: l.serverKey,
        templateServerKey: l.serverKey.trim(),
        connection: l.connection ?? {},
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return { schemaVersion: 2, users, api_tokens, token_mcps };
}

function defaultUsersPath(): string {
  const override = process.env.MCP_HUB_USERS_FILE?.trim();
  if (override) {
    return override;
  }
  return join(process.cwd(), "data", "hub-users.json");
}

export class HubUserStore {
  private readonly filePath: string;
  private data: HubUsersFile = emptyV2();
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultUsersPath();
  }

  getDataPath(): string {
    return this.filePath;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`;
    const json = `${JSON.stringify(this.data, null, 2)}\n`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.filePath);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isV2(parsed)) {
        this.data = {
          schemaVersion: 2,
          users: parsed.users,
          api_tokens: parsed.api_tokens,
          token_mcps: parsed.token_mcps,
        };
      } else if (isV1Shape(parsed)) {
        this.data = migrateV1ToV2(parsed);
        this.loaded = true;
        await this.persist();
        return;
      } else {
        this.data = emptyV2();
      }
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.data = emptyV2();
      } else {
        throw e;
      }
    }
    this.loaded = true;
  }

  invalidate(): void {
    this.loaded = false;
  }

  listUsers(): Pick<HubUser, "id" | "label" | "createdAt">[] {
    return this.data.users.map((u) => ({
      id: u.id,
      label: u.label,
      createdAt: u.createdAt,
    }));
  }

  getUserById(id: string): HubUser | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  /** Resolve por secret do token (cabeçalho X-MCP-Hub-User-Token). */
  getApiTokenBySecret(secret: string): ApiTokenRecord | undefined {
    const t = secret.trim();
    if (!t) {
      return undefined;
    }
    return this.data.api_tokens.find((x) => x.secret === t);
  }

  listTokensForUser(userId: string): Omit<ApiTokenRecord, "secret">[] {
    return this.data.api_tokens
      .filter((x) => x.userId === userId)
      .map(({ secret: _s, ...rest }) => rest);
  }

  getTokenById(tokenId: string): ApiTokenRecord | undefined {
    return this.data.api_tokens.find((x) => x.id === tokenId);
  }

  mcpsForToken(tokenId: string): TokenMcpRecord[] {
    return this.data.token_mcps.filter((m) => m.tokenId === tokenId);
  }

  getMcpById(mcpId: string): TokenMcpRecord | undefined {
    return this.data.token_mcps.find((m) => m.id === mcpId);
  }

  async createUser(label: string): Promise<{ user: HubUser }> {
    await this.load();
    const user: HubUser = {
      id: randomUUID(),
      label: label.trim() || "utilizador",
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    await this.persist();
    return { user };
  }

  async updateUser(userId: string, label: string): Promise<HubUser | undefined> {
    await this.load();
    const u = this.data.users.find((x) => x.id === userId);
    if (!u) {
      return undefined;
    }
    const next = label.trim();
    if (next) {
      u.label = next;
    }
    await this.persist();
    return u;
  }

  async deleteUser(userId: string): Promise<boolean> {
    await this.load();
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((u) => u.id !== userId);
    const tids = this.data.api_tokens.filter((t) => t.userId === userId).map((t) => t.id);
    this.data.api_tokens = this.data.api_tokens.filter((t) => t.userId !== userId);
    this.data.token_mcps = this.data.token_mcps.filter((m) => !tids.includes(m.tokenId));
    if (this.data.users.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  async createToken(
    userId: string,
    label: string,
  ): Promise<{ token: Omit<ApiTokenRecord, "secret">; secret: string }> {
    await this.load();
    if (!this.getUserById(userId)) {
      throw new Error("Utilizador não encontrado.");
    }
    const secret = randomBytes(32).toString("hex");
    const rec: ApiTokenRecord = {
      id: randomUUID(),
      userId,
      label: label.trim() || "token",
      secret,
      createdAt: new Date().toISOString(),
    };
    this.data.api_tokens.push(rec);
    await this.persist();
    const { secret: _s, ...token } = rec;
    return { token, secret };
  }

  async deleteToken(tokenId: string): Promise<boolean> {
    await this.load();
    const before = this.data.api_tokens.length;
    this.data.api_tokens = this.data.api_tokens.filter((t) => t.id !== tokenId);
    this.data.token_mcps = this.data.token_mcps.filter((m) => m.tokenId !== tokenId);
    if (this.data.api_tokens.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  async createMcp(
    tokenId: string,
    input: {
      label?: string;
      url?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      templateServerKey?: string;
      templateId?: string;
      connection?: HubConnectionOverrides;
    },
  ): Promise<TokenMcpRecord> {
    await this.load();
    if (!this.getTokenById(tokenId)) {
      throw new Error("Token não encontrado.");
    }
    const now = new Date().toISOString();
    const url = input.url?.trim();
    const tpl = input.templateServerKey?.trim();
    const tid = input.templateId?.trim();
    const modes = [Boolean(url), Boolean(tpl), Boolean(tid)].filter(Boolean).length;
    if (modes !== 1) {
      throw new Error(
        "Indica exactamente um modo: url (MCP directo), templateServerKey (catálogo) ou templateId (template admin).",
      );
    }
    const m: TokenMcpRecord = {
      id: randomUUID(),
      tokenId,
      label: input.label?.trim(),
      url: url || undefined,
      headers: input.headers,
      env: input.env,
      templateServerKey: tpl || undefined,
      templateId: tid || undefined,
      connection: input.connection ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.data.token_mcps.push(m);
    await this.persist();
    return m;
  }

  async updateMcp(
    mcpId: string,
    input: {
      label?: string;
      url?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      templateServerKey?: string;
      templateId?: string;
      connection?: HubConnectionOverrides;
    },
  ): Promise<TokenMcpRecord | undefined> {
    await this.load();
    const idx = this.data.token_mcps.findIndex((m) => m.id === mcpId);
    if (idx === -1) {
      return undefined;
    }
    const cur = this.data.token_mcps[idx]!;
    const modeInputs =
      input.url !== undefined ||
      input.templateServerKey !== undefined ||
      input.templateId !== undefined;

    let nextUrl = cur.url;
    let nextTpl = cur.templateServerKey;
    let nextTid = cur.templateId;

    if (modeInputs) {
      nextUrl = undefined;
      nextTpl = undefined;
      nextTid = undefined;
      if (input.url !== undefined && input.url.trim()) {
        nextUrl = input.url.trim();
      } else if (
        input.templateServerKey !== undefined &&
        input.templateServerKey.trim()
      ) {
        nextTpl = input.templateServerKey.trim();
      } else if (input.templateId !== undefined && input.templateId.trim()) {
        nextTid = input.templateId.trim();
      } else {
        nextUrl = cur.url;
        nextTpl = cur.templateServerKey;
        nextTid = cur.templateId;
      }
    }

    const modes = [Boolean(nextUrl), Boolean(nextTpl), Boolean(nextTid)].filter(
      Boolean,
    ).length;
    if (modes !== 1) {
      throw new Error(
        "O MCP tem de ficar com exactamente um modo: url, templateServerKey ou templateId.",
      );
    }
    const updated: TokenMcpRecord = {
      ...cur,
      label: input.label !== undefined ? input.label.trim() : cur.label,
      url: nextUrl,
      headers: input.headers !== undefined ? input.headers : cur.headers,
      env: input.env !== undefined ? input.env : cur.env,
      templateServerKey: nextTpl,
      templateId: nextTid,
      connection:
        input.connection !== undefined ? input.connection : cur.connection,
      updatedAt: new Date().toISOString(),
    };
    this.data.token_mcps[idx] = updated;
    await this.persist();
    return updated;
  }

  async deleteMcp(mcpId: string): Promise<boolean> {
    await this.load();
    const before = this.data.token_mcps.length;
    this.data.token_mcps = this.data.token_mcps.filter((m) => m.id !== mcpId);
    if (this.data.token_mcps.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }
}

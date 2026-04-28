import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  HubUser,
  HubUserLinkRecord,
  HubUsersFile,
} from "./types.js";

const empty: HubUsersFile = { users: [], links: [] };

function defaultUsersPath(): string {
  const override = process.env.MCP_HUB_USERS_FILE?.trim();
  if (override) {
    return override;
  }
  return join(process.cwd(), "data", "hub-users.json");
}

export class HubUserStore {
  private readonly filePath: string;
  private data: HubUsersFile = { ...empty };
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
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "users" in parsed &&
        "links" in parsed
      ) {
        const p = parsed as HubUsersFile;
        this.data = {
          users: Array.isArray(p.users) ? p.users : [],
          links: Array.isArray(p.links) ? p.links : [],
        };
      } else {
        this.data = { ...empty };
      }
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.data = { ...empty };
      } else {
        throw e;
      }
    }
    this.loaded = true;
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

  getUserByToken(token: string): HubUser | undefined {
    const t = token.trim();
    if (!t) {
      return undefined;
    }
    return this.data.users.find((u) => u.apiToken === t);
  }

  linksForUser(userId: string): HubUserLinkRecord[] {
    return this.data.links.filter((l) => l.userId === userId);
  }

  getLink(linkId: string): HubUserLinkRecord | undefined {
    return this.data.links.find((l) => l.id === linkId);
  }

  async createUser(label: string): Promise<{ user: HubUser; apiToken: string }> {
    await this.load();
    const apiToken = randomBytes(32).toString("hex");
    const user: HubUser = {
      id: randomUUID(),
      label: label.trim() || "utilizador",
      apiToken,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    await this.persist();
    return { user: { ...user, apiToken: "" }, apiToken };
  }

  async deleteUser(userId: string): Promise<boolean> {
    await this.load();
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((u) => u.id !== userId);
    this.data.links = this.data.links.filter((l) => l.userId !== userId);
    if (this.data.users.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  async addLink(
    userId: string,
    serverKey: string,
    connection: HubUserLinkRecord["connection"],
  ): Promise<HubUserLinkRecord> {
    await this.load();
    const link: HubUserLinkRecord = {
      id: randomUUID(),
      userId,
      serverKey: serverKey.trim(),
      connection: connection ?? {},
    };
    this.data.links = this.data.links.filter(
      (l) => !(l.userId === userId && l.serverKey === link.serverKey),
    );
    this.data.links.push(link);
    await this.persist();
    return link;
  }

  async updateLink(
    linkId: string,
    connection: HubUserLinkRecord["connection"],
  ): Promise<HubUserLinkRecord | undefined> {
    await this.load();
    const idx = this.data.links.findIndex((l) => l.id === linkId);
    if (idx === -1) {
      return undefined;
    }
    this.data.links[idx] = {
      ...this.data.links[idx]!,
      connection: connection ?? {},
    };
    await this.persist();
    return this.data.links[idx];
  }

  async deleteLink(linkId: string): Promise<boolean> {
    await this.load();
    const before = this.data.links.length;
    this.data.links = this.data.links.filter((l) => l.id !== linkId);
    if (this.data.links.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Documento na "coleção" mcp_servers (ficheiro JSON — substituível por MongoDB, etc.).
 * Chaves com o mesmo nome que em mcp-hub.config.json sobrepõem a entrada do ficheiro.
 */
export type McpServerDocument = {
  _id: string;
  key: string;
  label: string;
  def: unknown;
  createdAt: string;
  updatedAt: string;
};

type RegistryFile = {
  /** Nome de coleção estilo NoSQL */
  mcp_servers: McpServerDocument[];
};

const empty: RegistryFile = { mcp_servers: [] };

function defaultRegistryPath(): string {
  const o = process.env.MCP_HUB_MCP_REGISTRY_FILE?.trim();
  if (o) {
    return o;
  }
  return join(process.cwd(), "data", "hub-mcp-registry.json");
}

let singleton: McpRegistryStore | null = null;

export function getMcpRegistryStore(): McpRegistryStore {
  if (!singleton) {
    singleton = new McpRegistryStore();
  }
  return singleton;
}

export class McpRegistryStore {
  private readonly filePath: string;
  private data: RegistryFile = { mcp_servers: [] };
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultRegistryPath();
  }

  getFilePath(): string {
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
        "mcp_servers" in parsed &&
        Array.isArray((parsed as RegistryFile).mcp_servers)
      ) {
        this.data = {
          mcp_servers: (parsed as RegistryFile).mcp_servers.filter(
            (d): d is McpServerDocument =>
              d != null &&
              typeof d === "object" &&
              typeof (d as McpServerDocument)._id === "string" &&
              typeof (d as McpServerDocument).key === "string",
          ),
        };
      } else {
        this.data = structuredClone(empty);
      }
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.data = structuredClone(empty);
      } else {
        throw e;
      }
    }
    this.loaded = true;
  }

  /** Força releitura do disco na próxima operação. */
  invalidate(): void {
    this.loaded = false;
  }

  async list(): Promise<McpServerDocument[]> {
    await this.load();
    return [...this.data.mcp_servers];
  }

  async getById(id: string): Promise<McpServerDocument | undefined> {
    await this.load();
    return this.data.mcp_servers.find((d) => d._id === id);
  }

  keyExists(key: string, exceptId?: string): boolean {
    const k = key.trim();
    return this.data.mcp_servers.some(
      (d) => d.key === k && d._id !== exceptId,
    );
  }

  async create(
    key: string,
    label: string,
    def: unknown,
  ): Promise<McpServerDocument> {
    await this.load();
    const k = key.trim();
    if (!k) {
      throw new Error("A chave (key) do MCP é obrigatória.");
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(k)) {
      throw new Error(
        "Chave inválida: use apenas letras, números, _ , - e .",
      );
    }
    if (this.keyExists(k)) {
      throw new Error(`Já existe um MCP registado com a chave "${k}".`);
    }
    const now = new Date().toISOString();
    const doc: McpServerDocument = {
      _id: randomUUID(),
      key: k,
      label: (label || k).trim(),
      def,
      createdAt: now,
      updatedAt: now,
    };
    this.data.mcp_servers.push(doc);
    await this.persist();
    return doc;
  }

  async update(
    id: string,
    patch: { key?: string; label?: string; def?: unknown },
  ): Promise<McpServerDocument | undefined> {
    await this.load();
    const idx = this.data.mcp_servers.findIndex((d) => d._id === id);
    if (idx === -1) {
      return undefined;
    }
    const cur = this.data.mcp_servers[idx]!;
    const newKey = patch.key !== undefined ? patch.key.trim() : cur.key;
    if (!newKey) {
      throw new Error("Chave vazia.");
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(newKey)) {
      throw new Error(
        "Chave inválida: use apenas letras, números, _ , - e .",
      );
    }
    if (newKey !== cur.key && this.keyExists(newKey, id)) {
      throw new Error(`Já existe um MCP registado com a chave "${newKey}".`);
    }
    const updated: McpServerDocument = {
      ...cur,
      key: newKey,
      label:
        patch.label !== undefined ? String(patch.label).trim() : cur.label,
      def: patch.def !== undefined ? patch.def : cur.def,
      updatedAt: new Date().toISOString(),
    };
    this.data.mcp_servers[idx] = updated;
    await this.persist();
    return updated;
  }

  async deleteById(id: string): Promise<boolean> {
    await this.load();
    const before = this.data.mcp_servers.length;
    this.data.mcp_servers = this.data.mcp_servers.filter((d) => d._id !== id);
    if (this.data.mcp_servers.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }
}

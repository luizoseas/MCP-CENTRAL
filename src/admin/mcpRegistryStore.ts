import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isMongoPersistenceEnabled,
  mongoLoadRegistryState,
  mongoSaveRegistryState,
  mongoRegistryStateLabel,
} from "./mongoHubPersistence.js";
import { writeJsonToFile } from "./writeJsonFile.js";

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

/**
 * Template MCP definido pelo admin: URL/definição base fixa; utilizadores finais
 * escolhem o template e preenchem sobretudo cabeçalhos de acesso em `connection.headers`.
 */
export type McpTemplateDocument = {
  _id: string;
  /** Identificador curto único (UI); não confunde com chaves do catálogo `mcp_servers`. */
  key: string;
  label: string;
  description?: string;
  /** Definição MCP (stdio ou streamableHttp); use `${VAR}` nos headers quando fizer sentido. */
  def: unknown;
  /** Nomes de cabeçalhos que o painel sugere para preenchimento (só UX). */
  accessHeaderKeys?: string[];
  createdAt: string;
  updatedAt: string;
};

export type RegistryFile = {
  /** Nome de coleção estilo NoSQL */
  mcp_servers: McpServerDocument[];
  mcp_templates?: McpTemplateDocument[];
};

const empty: RegistryFile = { mcp_servers: [], mcp_templates: [] };

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
  private readonly useMongo: boolean;
  private data: RegistryFile = { mcp_servers: [] };

  constructor(filePath?: string) {
    this.useMongo = isMongoPersistenceEnabled();
    this.filePath = filePath ?? defaultRegistryPath();
  }

  getFilePath(): string {
    return this.useMongo ? mongoRegistryStateLabel() : this.filePath;
  }

  private applyParsedRegistry(parsed: unknown): void {
    if (
      parsed &&
      typeof parsed === "object" &&
      "mcp_servers" in parsed &&
      Array.isArray((parsed as RegistryFile).mcp_servers)
    ) {
      const p = parsed as RegistryFile;
      const templatesRaw = Array.isArray(p.mcp_templates)
        ? p.mcp_templates
        : [];
      this.data = {
        mcp_servers: p.mcp_servers.filter(
          (d): d is McpServerDocument =>
            d != null &&
            typeof d === "object" &&
            typeof (d as McpServerDocument)._id === "string" &&
            typeof (d as McpServerDocument).key === "string",
        ),
        mcp_templates: templatesRaw.filter(
          (d): d is McpTemplateDocument =>
            d != null &&
            typeof d === "object" &&
            typeof (d as McpTemplateDocument)._id === "string" &&
            typeof (d as McpTemplateDocument).key === "string",
        ),
      };
    } else {
      this.data = structuredClone(empty);
    }
  }

  private async persist(): Promise<void> {
    if (this.useMongo) {
      await mongoSaveRegistryState(this.data);
      return;
    }
    await writeJsonToFile(this.filePath, this.data);
  }

  /** Sempre relê MongoDB ou ficheiro (evita cache desactualizado entre pedidos). */
  async load(): Promise<void> {
    if (this.useMongo) {
      const parsed: unknown = await mongoLoadRegistryState();
      this.applyParsedRegistry(parsed);
      return;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.applyParsedRegistry(parsed);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.data = structuredClone(empty);
      } else {
        throw e;
      }
    }
  }

  async list(): Promise<McpServerDocument[]> {
    await this.load();
    return [...this.data.mcp_servers];
  }

  async listTemplates(): Promise<McpTemplateDocument[]> {
    await this.load();
    return [...(this.data.mcp_templates ?? [])];
  }

  async getTemplateById(id: string): Promise<McpTemplateDocument | undefined> {
    await this.load();
    return (this.data.mcp_templates ?? []).find((d) => d._id === id);
  }

  templateKeyExists(key: string, exceptId?: string): boolean {
    const k = key.trim();
    return (this.data.mcp_templates ?? []).some(
      (d) => d.key === k && d._id !== exceptId,
    );
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

  async createTemplate(input: {
    key: string;
    label: string;
    def: unknown;
    description?: string;
    accessHeaderKeys?: string[];
  }): Promise<McpTemplateDocument> {
    await this.load();
    if (!this.data.mcp_templates) {
      this.data.mcp_templates = [];
    }
    const k = input.key.trim();
    if (!k) {
      throw new Error("A chave (key) do template é obrigatória.");
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(k)) {
      throw new Error(
        "Chave inválida: use apenas letras, números, _ , - e .",
      );
    }
    if (this.templateKeyExists(k)) {
      throw new Error(`Já existe um template com a chave "${k}".`);
    }
    const now = new Date().toISOString();
    const doc: McpTemplateDocument = {
      _id: randomUUID(),
      key: k,
      label: (input.label || k).trim(),
      description: input.description?.trim() || undefined,
      def: input.def,
      accessHeaderKeys: (() => {
        const raw = input.accessHeaderKeys;
        if (!raw?.length) {
          return undefined;
        }
        const out = raw.map((h) => String(h).trim()).filter(Boolean);
        return out.length ? out : undefined;
      })(),
      createdAt: now,
      updatedAt: now,
    };
    this.data.mcp_templates.push(doc);
    await this.persist();
    return doc;
  }

  async updateTemplate(
    id: string,
    patch: {
      key?: string;
      label?: string;
      def?: unknown;
      description?: string;
      accessHeaderKeys?: string[];
    },
  ): Promise<McpTemplateDocument | undefined> {
    await this.load();
    const list = this.data.mcp_templates ?? [];
    const idx = list.findIndex((d) => d._id === id);
    if (idx === -1) {
      return undefined;
    }
    const cur = list[idx]!;
    const newKey = patch.key !== undefined ? patch.key.trim() : cur.key;
    if (!newKey) {
      throw new Error("Chave vazia.");
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(newKey)) {
      throw new Error(
        "Chave inválida: use apenas letras, números, _ , - e .",
      );
    }
    if (newKey !== cur.key && this.templateKeyExists(newKey, id)) {
      throw new Error(`Já existe um template com a chave "${newKey}".`);
    }
    const keys =
      patch.accessHeaderKeys !== undefined ?
        patch.accessHeaderKeys
          .map((h) => String(h).trim())
          .filter(Boolean)
      : cur.accessHeaderKeys;
    const updated: McpTemplateDocument = {
      ...cur,
      key: newKey,
      label:
        patch.label !== undefined ? String(patch.label).trim() : cur.label,
      def: patch.def !== undefined ? patch.def : cur.def,
      description:
        patch.description !== undefined ?
          patch.description.trim() || undefined
        : cur.description,
      accessHeaderKeys: keys?.length ? keys : undefined,
      updatedAt: new Date().toISOString(),
    };
    list[idx] = updated;
    this.data.mcp_templates = list;
    await this.persist();
    return updated;
  }

  async deleteTemplateById(id: string): Promise<boolean> {
    await this.load();
    const list = this.data.mcp_templates ?? [];
    const before = list.length;
    this.data.mcp_templates = list.filter((d) => d._id !== id);
    if ((this.data.mcp_templates ?? []).length === before) {
      return false;
    }
    await this.persist();
    return true;
  }
}

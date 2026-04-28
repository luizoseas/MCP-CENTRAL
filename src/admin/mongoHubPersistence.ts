import { MongoClient, type Collection } from "mongodb";
import type { HubUsersFile } from "./types.js";

/** Documento na mesma coleção que o registo MCP (catálogo + templates). */
export type RegistryBlob = {
  mcp_servers: unknown[];
  mcp_templates?: unknown[];
};

/** `_id` string (não ObjectId) para documentos singleton na coleção de estado. */
type HubStateDoc = {
  _id: string;
  [key: string]: unknown;
};

const USERS_DOC_ID = "hub_users_v2";
const REGISTRY_DOC_ID = "mcp_registry";

let client: MongoClient | undefined;
let connectPromise: Promise<MongoClient> | undefined;

export function isMongoPersistenceEnabled(): boolean {
  return Boolean(process.env.MCP_HUB_MONGODB_URI?.trim());
}

export function mongoDbName(): string {
  return process.env.MCP_HUB_MONGODB_DB?.trim() || "mcp_hub";
}

export function mongoCollectionName(): string {
  return process.env.MCP_HUB_MONGODB_COLLECTION?.trim() || "hub_state";
}

export function mongoUsersStateLabel(): string {
  return `MongoDB/${mongoDbName()}/${mongoCollectionName()}#${USERS_DOC_ID}`;
}

export function mongoRegistryStateLabel(): string {
  return `MongoDB/${mongoDbName()}/${mongoCollectionName()}#${REGISTRY_DOC_ID}`;
}

async function getClient(): Promise<MongoClient> {
  if (client) {
    return client;
  }
  if (!connectPromise) {
    const uri = process.env.MCP_HUB_MONGODB_URI!.trim();
    connectPromise = (async () => {
      const c = new MongoClient(uri);
      await c.connect();
      client = c;
      return c;
    })().finally(() => {
      connectPromise = undefined;
    });
  }
  return connectPromise;
}

async function collection(): Promise<Collection<HubStateDoc>> {
  const c = await getClient();
  return c.db(mongoDbName()).collection<HubStateDoc>(mongoCollectionName());
}

function stripId(doc: HubStateDoc | null): unknown {
  if (!doc) {
    return null;
  }
  const { _id: _ignored, ...rest } = doc;
  return rest;
}

export async function mongoLoadHubUsersState(): Promise<unknown | null> {
  const col = await collection();
  const doc = await col.findOne({ _id: USERS_DOC_ID });
  return stripId(doc);
}

export async function mongoSaveHubUsersState(data: HubUsersFile): Promise<void> {
  const col = await collection();
  const doc: HubStateDoc = { _id: USERS_DOC_ID, ...data };
  await col.replaceOne({ _id: USERS_DOC_ID }, doc, { upsert: true });
}

export async function mongoLoadRegistryState(): Promise<unknown | null> {
  const col = await collection();
  const doc = await col.findOne({ _id: REGISTRY_DOC_ID });
  return stripId(doc);
}

export async function mongoSaveRegistryState(data: RegistryBlob): Promise<void> {
  const col = await collection();
  const doc: HubStateDoc = { _id: REGISTRY_DOC_ID, ...data };
  await col.replaceOne({ _id: REGISTRY_DOC_ID }, doc, { upsert: true });
}

export async function closeMongoHubPersistence(): Promise<void> {
  connectPromise = undefined;
  if (client) {
    const c = client;
    client = undefined;
    await c.close().catch(() => undefined);
  }
}

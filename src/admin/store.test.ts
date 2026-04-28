import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrateV1ToV2, HubUserStore } from "./store.js";
import type { HubUsersFileV1 } from "./types.js";

describe("migrateV1ToV2", () => {
  it("converte utilizadores com apiToken e links para api_tokens e token_mcps", () => {
    const v1: HubUsersFileV1 = {
      users: [
        {
          id: "u1",
          label: "A",
          apiToken: "secret-abc",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      links: [
        {
          id: "l1",
          userId: "u1",
          serverKey: "eship-wms-foo",
          connection: { env: { FOO: "1" } },
        },
      ],
    };
    const v2 = migrateV1ToV2(v1);
    assert.equal(v2.schemaVersion, 2);
    assert.equal(v2.users.length, 1);
    assert.equal("apiToken" in v2.users[0]!, false);
    assert.equal(v2.api_tokens.length, 1);
    assert.equal(v2.api_tokens[0]!.secret, "secret-abc");
    assert.equal(v2.api_tokens[0]!.userId, "u1");
    assert.equal(v2.token_mcps.length, 1);
    assert.equal(v2.token_mcps[0]!.templateServerKey, "eship-wms-foo");
    assert.equal(v2.token_mcps[0]!.tokenId, v2.api_tokens[0]!.id);
  });
});

describe("HubUserStore", () => {
  it("CRUD token e MCP em cascata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hub-store-"));
    const filePath = join(dir, "hub-users.json");
    try {
      const store = new HubUserStore(filePath);
      await store.load();
      const { user } = await store.createUser("teste");
      const { secret } = await store.createToken(user.id, "t1");
      assert.ok(secret.length > 8);
      const tok = store.getApiTokenBySecret(secret);
      assert.ok(tok);
      const m = await store.createMcp(tok!.id, {
        label: "m1",
        url: "https://example.com/mcp",
        headers: { "X-A": "b" },
      });
      assert.equal(store.mcpsForToken(tok!.id).length, 1);
      await store.deleteToken(tok!.id);
      assert.equal(store.mcpsForToken(tok!.id).length, 0);
      assert.equal(store.getMcpById(m.id), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migra ficheiro v1 ao carregar e grava v2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hub-mig-"));
    const filePath = join(dir, "hub-users.json");
    try {
      const v1: HubUsersFileV1 = {
        users: [
          {
            id: "uu",
            label: "L",
            apiToken: "toktok",
            createdAt: "2021-06-01T00:00:00.000Z",
          },
        ],
        links: [],
      };
      await writeFile(filePath, JSON.stringify(v1), "utf8");
      const store = new HubUserStore(filePath);
      await store.load();
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as { schemaVersion: number };
      assert.equal(parsed.schemaVersion, 2);
      assert.ok(store.getApiTokenBySecret("toktok"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

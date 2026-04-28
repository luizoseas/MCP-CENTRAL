import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HubConfig } from "./hub.js";
import {
  buildHubConfigForApiToken,
  hubTemplateInjectKey,
  HubServerDefSchema,
  syntheticMcpServerKey,
} from "./hub.js";
import type { TokenMcpRecord } from "./admin/types.js";

const baseCatalog: HubConfig = {
  mcpServers: {
    "eship-wms-demo": HubServerDefSchema.parse({
      streamableHttp: {
        url: "https://wms.example/mcp",
        headers: { "X-Key": "${ESHIP_API_KEY}" },
      },
    }),
  },
};

function mcp(partial: Partial<TokenMcpRecord> & Pick<TokenMcpRecord, "id">): TokenMcpRecord {
  const now = "2024-01-01T00:00:00.000Z";
  return {
    id: partial.id,
    tokenId: partial.tokenId ?? "tok",
    label: partial.label,
    url: partial.url,
    headers: partial.headers,
    env: partial.env,
    templateServerKey: partial.templateServerKey,
    templateId: partial.templateId,
    connection: partial.connection,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

describe("buildHubConfigForApiToken", () => {
  it("rejeita lista vazia de MCPs", () => {
    assert.throws(
      () => buildHubConfigForApiToken(baseCatalog, [], "tid-uuid-here"),
      /não tem MCPs/,
    );
  });

  it("modo só URL directa", () => {
    const mcps = [
      mcp({
        id: "mcp-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        url: "https://direct.example/mcp",
        headers: { H: "v" },
      }),
    ];
    const { hubCfg, extraEnvByServer } = buildHubConfigForApiToken(
      { mcpServers: {} },
      mcps,
      "11111111-2222-3333-4444-555555555555",
    );
    const keys = Object.keys(hubCfg.mcpServers);
    assert.equal(keys.length, 1);
    const def = hubCfg.mcpServers[keys[0]!]!;
    assert.ok("streamableHttp" in def);
    assert.equal(def.streamableHttp.url, "https://direct.example/mcp");
    assert.deepEqual(extraEnvByServer[keys[0]!], {});
  });

  it("modo só catálogo (template)", () => {
    const mcps = [
      mcp({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        templateServerKey: "eship-wms-demo",
        connection: { headers: { "X-Extra": "1" } },
      }),
    ];
    const { hubCfg, extraEnvByServer } = buildHubConfigForApiToken(
      baseCatalog,
      mcps,
      "99999999-8888-7777-6666-555555555555",
    );
    const k = syntheticMcpServerKey(
      "99999999-8888-7777-6666-555555555555",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    assert.ok(hubCfg.mcpServers[k]);
    const def = hubCfg.mcpServers[k]!;
    assert.ok("streamableHttp" in def);
    assert.ok(def.streamableHttp.url.includes("wms.example"));
    assert.equal(def.streamableHttp.headers?.["X-Extra"], "1");
    assert.deepEqual(extraEnvByServer[k], {});
  });

  it("mistura direct + template", () => {
    const tokenId = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const mcps = [
      mcp({
        id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        url: "https://u.example/mcp",
      }),
      mcp({
        id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
        templateServerKey: "eship-wms-demo",
        connection: {},
        env: { MYVAR: "x" },
      }),
    ];
    const { hubCfg } = buildHubConfigForApiToken(baseCatalog, mcps, tokenId);
    assert.equal(Object.keys(hubCfg.mcpServers).length, 2);
  });

  it("modo template administrativo (templateId + connection.headers)", () => {
    const adminTid = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    const inj = hubTemplateInjectKey(adminTid);
    const hubBase: HubConfig = {
      mcpServers: {
        [inj]: HubServerDefSchema.parse({
          streamableHttp: {
            url: "https://tpl.example/mcp",
            headers: { "X-Base": "1" },
          },
        }),
      },
    };
    const mcps = [
      mcp({
        id: "bbbbbbbb-bbbb-cccc-dddd-222222222222",
        templateId: adminTid,
        connection: { headers: { "X-Access": "secret" } },
      }),
    ];
    const { hubCfg } = buildHubConfigForApiToken(
      hubBase,
      mcps,
      "99999999-8888-7777-6666-555555555555",
    );
    const k = syntheticMcpServerKey(
      "99999999-8888-7777-6666-555555555555",
      "bbbbbbbb-bbbb-cccc-dddd-222222222222",
    );
    const def = hubCfg.mcpServers[k]!;
    assert.ok("streamableHttp" in def);
    assert.equal(def.streamableHttp.headers?.["X-Access"], "secret");
    assert.equal(def.streamableHttp.headers?.["X-Base"], "1");
  });
});

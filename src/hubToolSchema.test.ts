import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHubToolsListEntries,
  hubToolListDescription,
  normalizeHubToolInputSchema,
} from "./hubToolSchema.js";

describe("normalizeHubToolInputSchema", () => {
  it("preenche object vazio quando schema ausente", () => {
    assert.deepEqual(normalizeHubToolInputSchema(undefined), {
      type: "object",
      properties: {},
    });
  });

  it("preserva properties e required do filho", () => {
    const normalized = normalizeHubToolInputSchema({
      type: "object",
      properties: {
        body: { type: "object", description: "payload" },
        id: { type: "string" },
      },
      required: ["body"],
      additionalProperties: true,
    });
    assert.equal(normalized.type, "object");
    assert.ok(normalized.properties?.body);
    assert.deepEqual(normalized.required, ["body"]);
    assert.equal(
      (normalized as { additionalProperties?: boolean }).additionalProperties,
      true,
    );
  });
});

describe("buildHubToolsListEntries", () => {
  it("anuncia inputSchema real (não properties vazias) para a IA", () => {
    const tools = buildHubToolsListEntries(
      [
        {
          name: "mcp_hub__meta",
          description: "meta",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      [
        {
          name: "eship-wms-cadastro__webServicePostCadastro",
          serverKey: "eship-wms-cadastro",
          meta: {
            originalName: "webServicePostCadastro",
            description: "Cria cadastro",
            inputSchema: {
              type: "object",
              properties: {
                body: { type: "object", description: "dados" },
              },
              required: ["body"],
            },
          },
        },
      ],
    );

    assert.equal(tools.length, 2);
    const post = tools[1]!;
    assert.equal(post.name, "eship-wms-cadastro__webServicePostCadastro");
    assert.match(post.description ?? "", /Cria cadastro/);
    assert.ok(post.inputSchema.properties?.body);
    assert.deepEqual(post.inputSchema.required, ["body"]);
    assert.notDeepEqual(post.inputSchema.properties, {});
  });
});

describe("hubToolListDescription", () => {
  it("usa descrição do upstream quando existe", () => {
    assert.equal(
      hubToolListDescription("srv", "tool", "  Faz X  "),
      "[srv] Faz X",
    );
  });
});

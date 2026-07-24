import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { argumentsForUpstream } from "./hub.js";
import {
  buildHubToolsListEntries,
  enrichHubToolInputSchema,
  hubToolListDescription,
  jsonSchemaToZodPassthrough,
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

describe("enrichHubToolInputSchema", () => {
  it("injeta body quando o filho não declara campos", () => {
    const enriched = enrichHubToolInputSchema({
      type: "object",
      properties: {},
    });
    assert.ok(enriched.properties?.body);
    assert.equal(
      (enriched as { additionalProperties?: boolean }).additionalProperties,
      true,
    );
  });

  it("não substitui properties existentes", () => {
    const enriched = enrichHubToolInputSchema({
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    });
    assert.ok(enriched.properties?.sku);
    assert.equal(enriched.properties?.body, undefined);
  });
});

describe("jsonSchemaToZodPassthrough", () => {
  it("aceita e repassa body e campos extra", () => {
    const schema = jsonSchemaToZodPassthrough({
      type: "object",
      properties: {
        nome: { type: "string", description: "nome" },
      },
      required: ["nome"],
    });
    const parsed = schema.safeParse({ nome: "x", extra: 1 });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.nome, "x");
      assert.equal((parsed.data as { extra?: number }).extra, 1);
    }
    const json = z.toJSONSchema(schema);
    assert.ok(
      json.properties &&
        typeof json.properties === "object" &&
        "nome" in json.properties,
    );
  });
});

describe("argumentsForUpstream", () => {
  it("expande único campo body para o topo", () => {
    assert.deepEqual(argumentsForUpstream({ body: { a: 1, b: "x" } }), {
      a: 1,
      b: "x",
    });
  });

  it("mantém arguments flat sem alteração", () => {
    assert.deepEqual(argumentsForUpstream({ a: 1, body: { z: 9 } }), {
      a: 1,
      body: { z: 9 },
    });
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

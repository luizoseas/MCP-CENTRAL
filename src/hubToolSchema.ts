/**
 * Preserva e normaliza inputSchema dos MCPs filhos para o tools/list do hub.
 * Sem isto, o hub anunciava z.object({}).passthrough() → properties: {} e a IA
 * não sabia quais campos (body) enviar em vários webServices.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type HubToolInputSchema = Tool["inputSchema"];

export type HubExposedToolMeta = {
  originalName: string;
  description?: string;
  inputSchema: HubToolInputSchema;
  annotations?: Tool["annotations"];
};

function propertyCount(schema: HubToolInputSchema): number {
  return Object.keys(schema.properties ?? {}).length;
}

/** Garante shape MCP (type: object) sem descartar properties/required/$defs. */
export function normalizeHubToolInputSchema(
  schema: unknown,
): HubToolInputSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const s = schema as Record<string, unknown>;
  const properties =
    s.properties &&
    typeof s.properties === "object" &&
    !Array.isArray(s.properties)
      ? (s.properties as Record<string, object>)
      : {};
  const out: HubToolInputSchema = {
    ...(s as HubToolInputSchema),
    type: "object",
    properties,
  };
  if (Array.isArray(s.required)) {
    out.required = s.required.filter((r): r is string => typeof r === "string");
  }
  return out;
}

/**
 * Se o filho não declara campos, injeta `body` + additionalProperties para a IA
 * conseguir enviar JSON. Não altera schemas que já têm properties.
 */
export function enrichHubToolInputSchema(schema: unknown): HubToolInputSchema {
  const normalized = normalizeHubToolInputSchema(schema);
  if (propertyCount(normalized) > 0) {
    return {
      ...normalized,
      additionalProperties:
        (normalized as { additionalProperties?: unknown }).additionalProperties ??
        true,
    };
  }
  return {
    type: "object",
    properties: {
      body: {
        type: "object",
        description:
          "Payload JSON do web service. Quando o MCP filho não declara campos, envie aqui o objeto esperado pela API (ou use campos no topo do arguments — additionalProperties está activo).",
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

function propToZod(prop: unknown): z.ZodTypeAny {
  if (!prop || typeof prop !== "object" || Array.isArray(prop)) {
    return z.unknown();
  }
  const p = prop as Record<string, unknown>;
  let base: z.ZodTypeAny;
  const t = p.type;
  if (t === "string") {
    base = z.string();
  } else if (t === "number") {
    base = z.number();
  } else if (t === "integer") {
    base = z.number().int();
  } else if (t === "boolean") {
    base = z.boolean();
  } else if (t === "array") {
    base = z.array(propToZod(p.items));
  } else if (t === "object" || p.properties) {
    if (p.properties && typeof p.properties === "object") {
      base = jsonSchemaToZodPassthrough(p);
    } else {
      base = z.record(z.string(), z.unknown());
    }
  } else if (t === "null") {
    base = z.null();
  } else {
    base = z.unknown();
  }
  if (typeof p.description === "string" && p.description.trim()) {
    base = base.describe(p.description);
  }
  return base;
}

/**
 * Converte JSON Schema do filho em Zod com .passthrough() para registerTool.
 * Assim o SDK anuncia properties reais (não só o override de tools/list).
 */
export function jsonSchemaToZodPassthrough(schema: unknown): z.ZodObject {
  const s = enrichHubToolInputSchema(schema);
  const props = s.properties ?? {};
  const required = new Set(
    Array.isArray(s.required)
      ? s.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const field = propToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape).passthrough();
}

export function hubToolListDescription(
  serverKey: string,
  originalName: string,
  upstreamDescription: string | undefined,
): string {
  const base = upstreamDescription?.trim();
  if (base) {
    return `[${serverKey}] ${base}`;
  }
  return `[${serverKey}] → ${originalName} (argumentos repassados ao servidor original).`;
}

/** Entradas de tools/list com schema real do upstream (para a IA montar o body). */
export function buildHubToolsListEntries(
  metaTools: Array<{
    name: string;
    description: string;
    inputSchema?: HubToolInputSchema;
  }>,
  exposed: Array<{
    name: string;
    serverKey: string;
    meta: HubExposedToolMeta;
  }>,
): Tool[] {
  const tools: Tool[] = metaTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: enrichHubToolInputSchema(t.inputSchema),
  }));

  for (const row of exposed) {
    tools.push({
      name: row.name,
      title: row.name,
      description: hubToolListDescription(
        row.serverKey,
        row.meta.originalName,
        row.meta.description,
      ),
      inputSchema: enrichHubToolInputSchema(row.meta.inputSchema),
      ...(row.meta.annotations ? { annotations: row.meta.annotations } : {}),
    });
  }
  return tools;
}

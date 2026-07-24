/**
 * Preserva e normaliza inputSchema dos MCPs filhos para o tools/list do hub.
 * Sem isto, o hub anunciava z.object({}).passthrough() → properties: {} e a IA
 * não sabia quais campos (body) enviar em vários webServices.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type HubToolInputSchema = Tool["inputSchema"];

export type HubExposedToolMeta = {
  originalName: string;
  description?: string;
  inputSchema: HubToolInputSchema;
  annotations?: Tool["annotations"];
};

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
    inputSchema: normalizeHubToolInputSchema(t.inputSchema),
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
      inputSchema: normalizeHubToolInputSchema(row.meta.inputSchema),
      ...(row.meta.annotations ? { annotations: row.meta.annotations } : {}),
    });
  }
  return tools;
}

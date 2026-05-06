import { randomUUID } from "node:crypto";

export type SystemLogLevel = "info" | "error";
export type SystemLogSource = "mcp" | "panel" | "ldap" | "admin";

export type SystemLogEntry = {
  id: string;
  ts: string;
  level: SystemLogLevel;
  source: SystemLogSource;
  code: string;
  message: string;
  detail?: string;
};

const MAX_ENTRIES = 500;
const entries: SystemLogEntry[] = [];

function toDetail(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    return cause.message || cause.name;
  }
  if (typeof cause === "string") {
    return cause;
  }
  if (cause === null || cause === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function pushSystemLog(input: {
  level: SystemLogLevel;
  source: SystemLogSource;
  code: string;
  message: string;
  cause?: unknown;
}): SystemLogEntry {
  const entry: SystemLogEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    level: input.level,
    source: input.source,
    code: input.code,
    message: input.message,
    detail: toDetail(input.cause),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  return entry;
}

export function getSystemLogs(limit = 100): SystemLogEntry[] {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100;
  return entries.slice(-n).reverse();
}

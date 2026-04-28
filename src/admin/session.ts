import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "mcp_hub_admin";

export type AdminSessionPayload = {
  exp: number;
  v: number;
  /** Nome mostrado no painel (login LDAP ou "Admin" para login por palavra-passe). */
  sub: string;
};

export function adminCookieName(): string {
  return COOKIE;
}

export function signAdminSession(
  secret: string,
  maxAgeMs: number,
  displayName: string,
): string {
  const exp = Date.now() + maxAgeMs;
  const sub = displayName.trim() || "Admin";
  const payload = JSON.stringify({ exp, v: 1, sub });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

/** Valida assinatura e prazo; devolve o payload ou null. Sessões antigas sem `sub` tratam-se como "Admin". */
export function parseAdminSession(
  secret: string,
  token: string,
): AdminSessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(b64).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }
  } catch {
    return null;
  }
  let parsed: { exp?: number; v?: number; sub?: string };
  try {
    parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      exp?: number;
      v?: number;
      sub?: string;
    };
  } catch {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) {
    return null;
  }
  const sub =
    typeof parsed.sub === "string" && parsed.sub.trim()
      ? parsed.sub.trim()
      : "Admin";
  return { exp: parsed.exp, v: typeof parsed.v === "number" ? parsed.v : 1, sub };
}

export function verifyAdminSession(secret: string, token: string): boolean {
  return parseAdminSession(secret, token) !== null;
}

export function readAdminCookie(req: {
  headers: { cookie?: string };
}): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) {
    return undefined;
  }
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) {
      return decodeURIComponent(rest.join("=").trim());
    }
  }
  return undefined;
}

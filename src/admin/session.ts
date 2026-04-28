import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "mcp_hub_admin";

export function adminCookieName(): string {
  return COOKIE;
}

export function signAdminSession(secret: string, maxAgeMs: number): string {
  const exp = Date.now() + maxAgeMs;
  const payload = JSON.stringify({ exp, v: 1 });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyAdminSession(secret: string, token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(b64).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    if (!timingSafeEqual(a, b)) {
      return false;
    }
  } catch {
    return false;
  }
  let parsed: { exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      exp?: number;
    };
  } catch {
    return false;
  }
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) {
    return false;
  }
  return true;
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

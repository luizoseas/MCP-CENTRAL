import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type Router } from "express";
import type { McpRegistryStore } from "./mcpRegistryStore.js";
import { HubUserStore } from "./store.js";
import {
  adminCookieName,
  parseAdminSession,
  readAdminCookie,
  signAdminSession,
  type HubAdminRole,
} from "./session.js";
import { isMongoPersistenceEnabled, mongoCollectionName, mongoDbName } from "./mongoHubPersistence.js";
import type { HubConnectionOverrides } from "./types.js";
import {
  verifyLdapUserPassword,
  type HubLdapOptions,
} from "./ldapAuth.js";
import { getSystemLogs, pushSystemLog } from "../systemLog.js";

/** Com LDAP activo, este nome inicia sessão com MCP_HUB_ADMIN_PASSWORD (conta local), sem consultar o AD. */
const RESERVED_LOCAL_ADMIN_USER = "admin";
const AD_GROUP_ADMIN = "administrator";
const AD_GROUP_LIDERANCA = "lideranca";

const SESSION_MS = 8 * 60 * 60 * 1000;

type AdminSessionData = { displayName: string; role: HubAdminRole };

function adminPublicDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../public/hub-admin");
}

function parseJsonBody(req: Request): unknown {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body;
  }
  return {};
}

function sendPanelError(
  res: Response,
  status: number,
  code: string,
  message: string,
  cause?: unknown,
): void {
  const logged = pushSystemLog({
    level: "error",
    source: "panel",
    code,
    message,
    cause,
  });
  res.status(status).json({
    error: message,
    code,
    errorId: logged.id,
    detail: logged.detail,
  });
}

function adGroupTokens(groupDnOrName: string): string[] {
  const g = groupDnOrName.trim();
  if (!g) {
    return [];
  }
  const out = [g.toLowerCase()];
  for (const piece of g.split(",")) {
    const p = piece.trim();
    if (/^cn=/i.test(p)) {
      out.push(p.slice(3).trim().toLowerCase());
    }
  }
  return [...new Set(out)];
}

function ldapRoleFromGroups(groups: string[]): HubAdminRole | null {
  const tokens = new Set(
    groups.flatMap((g) => adGroupTokens(g)).map((x) => x.toLowerCase()),
  );
  if (tokens.has(AD_GROUP_ADMIN)) {
    return "admin";
  }
  if (tokens.has(AD_GROUP_LIDERANCA)) {
    return "lideranca";
  }
  return null;
}

const ADMIN_NOT_CONFIGURED_MSG =
  "Painel admin não configurado. Configura login por palavra-passe ou LDAP e reinicia o hub.";

const disabledSetupHtml = `<!DOCTYPE html>
<html lang="pt"><head><meta charset="utf-8"/><title>MCP Hub — Admin</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5;background:#0f1419;color:#e7ecf3}
code{background:#1a2332;padding:.15rem .4rem;border-radius:4px}</style></head><body>
<h1>Painel admin — configuração em falta</h1>
<p>O servidor HTTP está a correr, mas o admin <strong>não foi activado</strong>.</p>
<p>Configura <strong>login por palavra-passe</strong> ou <strong>LDAP</strong> no processo do hub (ficheiro de ambiente do deployment) e reinicia.</p>
<p>Em Docker, ajusta o compose ou o ficheiro de env do contentor e recria o serviço.</p>
<p>O endpoint <code>GET …/mcp/health</code> indica quando o painel está activo.</p>
</body></html>`;

export type HubAdminLoginMode = "password" | "ldap";

export function createHubAdminRouter(opts: {
  hubAdminEnabled: boolean;
  store: HubUserStore;
  registry: McpRegistryStore;
  /** Vazio quando só LDAP. */
  adminPassword: string;
  sessionSecret: string;
  loginMode: HubAdminLoginMode;
  ldapOptions: HubLdapOptions | null;
  getMergedServerKeys: () => Promise<string[]>;
  parseServerDef: (v: unknown) => unknown;
  /** Caminho HTTP do endpoint MCP (ex. /mcp), sem host — para instruções no painel. */
  mcpHttpPath: string;
}): Router {
  const r = express.Router();
  const {
    hubAdminEnabled,
    store,
    registry,
    adminPassword,
    sessionSecret,
    loginMode,
    ldapOptions,
    getMergedServerKeys,
    parseServerDef,
    mcpHttpPath,
  } = opts;

  const adminNotReady = (_req: Request, res: Response) => {
    res.status(503).json({
      error: ADMIN_NOT_CONFIGURED_MSG,
      code: "ADMIN_NOT_CONFIGURED",
    });
  };

  const currentSession = (req: Request): AdminSessionData | null => {
    const tok = readAdminCookie(req);
    const sess = tok ? parseAdminSession(sessionSecret, tok) : null;
    if (!sess) {
      return null;
    }
    return { displayName: sess.sub, role: sess.role };
  };

  const requireAdmin = (req: Request, res: Response, next: () => void) => {
    if (!hubAdminEnabled) {
      adminNotReady(req, res);
      return;
    }
    const sess = currentSession(req);
    if (!sess) {
      sendPanelError(res, 401, "AUTH_REQUIRED", "Não autenticado.");
      return;
    }
    res.locals.adminRole = sess.role;
    res.locals.adminDisplayName = sess.displayName;
    next();
  };

  const requireDeletePermission = (
    req: Request,
    res: Response,
    next: () => void,
  ) => {
    const sess = currentSession(req);
    if (!sess) {
      sendPanelError(res, 401, "AUTH_REQUIRED", "Não autenticado.");
      return;
    }
    if (sess.role !== "admin") {
      sendPanelError(
        res,
        403,
        "DELETE_FORBIDDEN",
        "Sem permissão para excluir. Apenas membros do grupo AD Administrator podem apagar.",
      );
      return;
    }
    next();
  };

  r.get("/api/auth-config", (_req: Request, res: Response) => {
    if (!hubAdminEnabled) {
      res.json({ configured: false, loginMode: null });
      return;
    }
    res.json({ configured: true, loginMode });
  });

  r.post("/api/login", async (req: Request, res: Response) => {
    if (!hubAdminEnabled) {
      adminNotReady(req, res);
      return;
    }
    const body = parseJsonBody(req) as { password?: string; username?: string };
    const pw = String(body.password ?? "");
    const username = String(body.username ?? "").trim();
    let role: HubAdminRole = "admin";

    try {
      if (loginMode === "ldap") {
        if (!ldapOptions) {
          sendPanelError(
            res,
            500,
            "LDAP_CONFIG_MISSING",
            "LDAP não está configurado no servidor.",
          );
          return;
        }
        if (!username) {
          sendPanelError(res, 400, "LOGIN_USERNAME_REQUIRED", "Indica o utilizador.");
          return;
        }
        if (!pw) {
          sendPanelError(res, 400, "LOGIN_PASSWORD_REQUIRED", "Indica a palavra-passe.");
          return;
        }
        const isLocalAdmin =
          username.toLowerCase() === RESERVED_LOCAL_ADMIN_USER;
        if (isLocalAdmin) {
          if (!adminPassword) {
            sendPanelError(
              res,
              400,
              "LOCAL_ADMIN_PASSWORD_MISSING",
              "A conta reservada «admin» usa a palavra-passe local (MCP_HUB_ADMIN_PASSWORD), mas essa variável não está definida.",
            );
            return;
          }
          if (!timingSafeEqualStr(adminPassword, pw)) {
            sendPanelError(
              res,
              401,
              "LOCAL_ADMIN_PASSWORD_INVALID",
              "Palavra-passe inválida para a conta local «admin».",
            );
            return;
          }
          role = "admin";
        } else {
          const ldapResult = await verifyLdapUserPassword(
            ldapOptions,
            username,
            pw,
          );
          if (!ldapResult.ok) {
            const code = ldapResult.statusCode ?? 401;
            sendPanelError(res, code, "LDAP_AUTH_FAILED", ldapResult.error);
            return;
          }
          const ldapRole = ldapRoleFromGroups(ldapResult.groups);
          if (!ldapRole) {
            sendPanelError(
              res,
              403,
              "LDAP_GROUP_FORBIDDEN",
              "Utilizador autenticado no AD, mas sem autorização no painel. Requer grupo Administrator ou Lideranca.",
            );
            return;
          }
          role = ldapRole;
        }
      } else {
        if (!timingSafeEqualStr(adminPassword, pw)) {
          sendPanelError(res, 401, "PASSWORD_INVALID", "Palavra-passe inválida.");
          return;
        }
        role = "admin";
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendPanelError(res, 500, "LOGIN_INTERNAL_ERROR", msg, e);
      return;
    }

    const displayName =
      loginMode === "ldap"
        ? username.toLowerCase() === RESERVED_LOCAL_ADMIN_USER
          ? "Admin"
          : username
        : "Admin";
    const token = signAdminSession(sessionSecret, SESSION_MS, displayName, role);
    const maxAgeSec = Math.floor(SESSION_MS / 1000);
    res.setHeader(
      "Set-Cookie",
      `${adminCookieName()}=${encodeURIComponent(token)}; HttpOnly; Path=/hub-admin; SameSite=Lax; Max-Age=${maxAgeSec}`,
    );
    res.json({ ok: true, displayName, role });
  });

  r.post("/api/logout", (_req: Request, res: Response) => {
    res.setHeader(
      "Set-Cookie",
      `${adminCookieName()}=; HttpOnly; Path=/hub-admin; SameSite=Lax; Max-Age=0`,
    );
    res.json({ ok: true });
  });

  r.get("/api/me", (req: Request, res: Response) => {
    if (!hubAdminEnabled) {
      res.json({ ok: false, admin: false, configured: false });
      return;
    }
    const tok = readAdminCookie(req);
    const sess = tok ? parseAdminSession(sessionSecret, tok) : null;
    if (!sess) {
      res.json({ ok: false, admin: false, configured: true });
      return;
    }
    res.json({
      ok: true,
      admin: true,
      configured: true,
      displayName: sess.sub,
      role: sess.role,
      canDelete: sess.role === "admin",
    });
  });

  r.get("/api/servers", requireAdmin, async (_req: Request, res: Response) => {
    res.json({ servers: await getMergedServerKeys() });
  });

  r.get("/api/users", requireAdmin, async (_req: Request, res: Response) => {
    await store.load();
    const users = store.listUsers();
    const out = users.map((u) => ({
      ...u,
      tokens: store.listTokensForUser(u.id),
    }));
    res.json({ users: out });
  });

  r.post("/api/users", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = parseJsonBody(req) as { label?: string };
      await store.load();
      const { user } = await store.createUser(String(body.label ?? ""));
      res.status(201).json({ user });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendPanelError(res, 500, "USERS_CREATE_ERROR", msg, e);
    }
  });

  r.delete("/api/users/:id", requireAdmin, requireDeletePermission, async (req: Request, res: Response) => {
    await store.load();
    const ok = await store.deleteUser(String(req.params.id ?? "").trim());
    if (!ok) {
      sendPanelError(res, 404, "USER_NOT_FOUND", "Utilizador não encontrado.");
      return;
    }
    res.json({ ok: true });
  });

  r.put("/api/users/:id", requireAdmin, async (req: Request, res: Response) => {
    const body = parseJsonBody(req) as { label?: string };
    const label = String(body.label ?? "").trim();
    if (!label) {
      sendPanelError(res, 400, "LABEL_REQUIRED", "Campo label é obrigatório.");
      return;
    }
    await store.load();
    const updated = await store.updateUser(String(req.params.id ?? "").trim(), label);
    if (!updated) {
      sendPanelError(res, 404, "USER_NOT_FOUND", "Utilizador não encontrado.");
      return;
    }
    res.json({ user: updated });
  });

  r.get(
    "/api/users/:id/tokens",
    requireAdmin,
    async (req: Request, res: Response) => {
      await store.load();
      const uid = String(req.params.id ?? "").trim();
      if (!store.getUserById(uid)) {
        sendPanelError(res, 404, "USER_NOT_FOUND", "Utilizador não encontrado.");
        return;
      }
      res.json({ tokens: store.listTokensForUser(uid) });
    },
  );

  r.post(
    "/api/users/:id/tokens",
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = parseJsonBody(req) as { label?: string };
      await store.load();
      const uid = String(req.params.id ?? "").trim();
      if (!store.getUserById(uid)) {
        sendPanelError(res, 404, "USER_NOT_FOUND", "Utilizador não encontrado.");
        return;
      }
      try {
        const { token, secret } = await store.createToken(
          uid,
          String(body.label ?? ""),
        );
        res.status(201).json({ token, secret });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        sendPanelError(res, 400, "TOKEN_CREATE_ERROR", msg, e);
      }
    },
  );

  r.delete(
    "/api/users/:id/tokens/:tid",
    requireAdmin,
    requireDeletePermission,
    async (req: Request, res: Response) => {
      await store.load();
      const uid = String(req.params.id ?? "").trim();
      const tid = String(req.params.tid ?? "").trim();
      const owner = store.getUserById(uid);
      const t = store.getTokenById(tid);
      if (!owner || !t || t.userId !== owner.id) {
        sendPanelError(res, 404, "TOKEN_NOT_FOUND", "Token não encontrado.");
        return;
      }
      await store.deleteToken(tid);
      res.json({ ok: true });
    },
  );

  r.get(
    "/api/tokens/:tid/mcps",
    requireAdmin,
    async (req: Request, res: Response) => {
      await store.load();
      const tid = String(req.params.tid ?? "").trim();
      if (!store.getTokenById(tid)) {
        sendPanelError(res, 404, "TOKEN_NOT_FOUND", "Token não encontrado.");
        return;
      }
      res.json({ mcps: store.mcpsForToken(tid) });
    },
  );

  r.post(
    "/api/tokens/:tid/mcps",
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = parseJsonBody(req) as {
        label?: string;
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        templateServerKey?: string;
        templateId?: string;
        connection?: HubConnectionOverrides;
      };
      await store.load();
      const tid = String(req.params.tid ?? "").trim();
      if (!store.getTokenById(tid)) {
        sendPanelError(res, 404, "TOKEN_NOT_FOUND", "Token não encontrado.");
        return;
      }
      if (body.templateServerKey?.trim()) {
        const keys = await getMergedServerKeys();
        if (!keys.includes(body.templateServerKey.trim())) {
          sendPanelError(
            res,
            400,
            "TEMPLATE_SERVER_KEY_INVALID",
            "templateServerKey inválido ou não existe no hub.",
          );
          return;
        }
      }
      if (body.templateId?.trim()) {
        await registry.load();
        const doc = await registry.getTemplateById(body.templateId.trim());
        if (!doc) {
          sendPanelError(
            res,
            400,
            "TEMPLATE_ID_INVALID",
            "templateId inválido (template admin inexistente).",
          );
          return;
        }
      }
      try {
        const mcp = await store.createMcp(tid, {
          label: body.label,
          url: body.url,
          headers: body.headers,
          env: body.env,
          templateServerKey: body.templateServerKey,
          templateId: body.templateId,
          connection: body.connection,
        });
        res.status(201).json({ mcp });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        sendPanelError(res, 400, "MCP_CREATE_ERROR", msg, e);
      }
    },
  );

  r.put(
    "/api/tokens/:tid/mcps/:mid",
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = parseJsonBody(req) as {
        label?: string;
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        templateServerKey?: string;
        templateId?: string;
        connection?: HubConnectionOverrides;
      };
      await store.load();
      const tid = String(req.params.tid ?? "").trim();
      const mid = String(req.params.mid ?? "").trim();
      const tok = store.getTokenById(tid);
      const existing = store.getMcpById(mid);
      if (!existing || !tok || existing.tokenId !== tok.id) {
        sendPanelError(res, 404, "MCP_NOT_FOUND", "MCP não encontrado.");
        return;
      }
      if (body.templateServerKey !== undefined && body.templateServerKey.trim()) {
        const keys = await getMergedServerKeys();
        if (!keys.includes(body.templateServerKey.trim())) {
          sendPanelError(
            res,
            400,
            "TEMPLATE_SERVER_KEY_INVALID",
            "templateServerKey inválido ou não existe no hub.",
          );
          return;
        }
      }
      if (body.templateId !== undefined && body.templateId.trim()) {
        await registry.load();
        const doc = await registry.getTemplateById(body.templateId.trim());
        if (!doc) {
          sendPanelError(
            res,
            400,
            "TEMPLATE_ID_INVALID",
            "templateId inválido (template admin inexistente).",
          );
          return;
        }
      }
      try {
        const mcp = await store.updateMcp(mid, {
          label: body.label,
          url: body.url,
          headers: body.headers,
          env: body.env,
          templateServerKey: body.templateServerKey,
          templateId: body.templateId,
          connection: body.connection,
        });
        res.json({ mcp });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        sendPanelError(res, 400, "MCP_UPDATE_ERROR", msg, e);
      }
    },
  );

  r.delete(
    "/api/tokens/:tid/mcps/:mid",
    requireAdmin,
    requireDeletePermission,
    async (req: Request, res: Response) => {
      await store.load();
      const tid = String(req.params.tid ?? "").trim();
      const mid = String(req.params.mid ?? "").trim();
      const tok = store.getTokenById(tid);
      const existing = store.getMcpById(mid);
      if (!existing || !tok || existing.tokenId !== tok.id) {
        sendPanelError(res, 404, "MCP_NOT_FOUND", "MCP não encontrado.");
        return;
      }
      await store.deleteMcp(mid);
      res.json({ ok: true });
    },
  );

  r.get("/api/mcp-templates", requireAdmin, async (_req: Request, res: Response) => {
    await registry.load();
    const templates = await registry.listTemplates();
    res.json({ collection: "mcp_templates", templates });
  });

  r.post("/api/mcp-templates", requireAdmin, async (req: Request, res: Response) => {
    const body = parseJsonBody(req) as {
      key?: string;
      label?: string;
      def?: unknown;
      description?: string;
      accessHeaderKeys?: string[];
    };
    try {
      if (body.def === undefined) {
        sendPanelError(
          res,
          400,
          "TEMPLATE_DEF_REQUIRED",
          "Campo def (JSON do servidor MCP base) é obrigatório.",
        );
        return;
      }
      parseServerDef(body.def);
      const doc = await registry.createTemplate({
        key: String(body.key ?? ""),
        label: String(body.label ?? ""),
        def: body.def,
        description: body.description,
        accessHeaderKeys: body.accessHeaderKeys,
      });
      res.status(201).json({ template: doc });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendPanelError(res, 400, "TEMPLATE_CREATE_ERROR", msg, e);
    }
  });

  r.put("/api/mcp-templates/:id", requireAdmin, async (req: Request, res: Response) => {
    const body = parseJsonBody(req) as {
      key?: string;
      label?: string;
      def?: unknown;
      description?: string;
      accessHeaderKeys?: string[];
    };
    try {
      if (body.def !== undefined) {
        parseServerDef(body.def);
      }
      const updated = await registry.updateTemplate(String(req.params.id ?? ""), {
        key: body.key,
        label: body.label,
        def: body.def,
        description: body.description,
        accessHeaderKeys: body.accessHeaderKeys,
      });
      if (!updated) {
        sendPanelError(res, 404, "TEMPLATE_NOT_FOUND", "Template não encontrado.");
        return;
      }
      res.json({ template: updated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendPanelError(res, 400, "TEMPLATE_UPDATE_ERROR", msg, e);
    }
  });

  r.delete("/api/mcp-templates/:id", requireAdmin, requireDeletePermission, async (req: Request, res: Response) => {
    await registry.load();
    const ok = await registry.deleteTemplateById(String(req.params.id ?? ""));
    if (!ok) {
      sendPanelError(res, 404, "TEMPLATE_NOT_FOUND", "Template não encontrado.");
      return;
    }
    res.json({ ok: true });
  });

  r.get("/api/mcp-registry", requireAdmin, async (_req: Request, res: Response) => {
    await registry.load();
    const docs = await registry.list();
    res.json({ collection: "mcp_servers", documents: docs });
  });

  r.post("/api/mcp-registry", requireAdmin, async (req: Request, res: Response) => {
    const body = parseJsonBody(req) as {
      key?: string;
      label?: string;
      def?: unknown;
    };
    try {
      if (body.def === undefined) {
        sendPanelError(
          res,
          400,
          "REGISTRY_DEF_REQUIRED",
          "Campo def (JSON do servidor MCP) é obrigatório.",
        );
        return;
      }
      parseServerDef(body.def);
      const doc = await registry.create(
        String(body.key ?? ""),
        String(body.label ?? ""),
        body.def,
      );
      res.status(201).json({ document: doc });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendPanelError(res, 400, "REGISTRY_CREATE_ERROR", msg, e);
    }
  });

  r.put("/api/mcp-registry/:id", requireAdmin, async (req: Request, res: Response) => {
    const body = parseJsonBody(req) as {
      key?: string;
      label?: string;
      def?: unknown;
    };
    try {
      if (body.def !== undefined) {
        parseServerDef(body.def);
      }
      const updated = await registry.update(String(req.params.id ?? ""), {
        key: body.key,
        label: body.label,
        def: body.def,
      });
      if (!updated) {
        sendPanelError(res, 404, "REGISTRY_DOC_NOT_FOUND", "Documento não encontrado.");
        return;
      }
      res.json({ document: updated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendPanelError(res, 400, "REGISTRY_UPDATE_ERROR", msg, e);
    }
  });

  r.delete("/api/mcp-registry/:id", requireAdmin, requireDeletePermission, async (req: Request, res: Response) => {
    const ok = await registry.deleteById(String(req.params.id ?? ""));
    if (!ok) {
      sendPanelError(res, 404, "REGISTRY_DOC_NOT_FOUND", "Documento não encontrado.");
      return;
    }
    res.json({ ok: true });
  });

  r.get("/api/config", requireAdmin, (_req: Request, res: Response) => {
    const mongo = isMongoPersistenceEnabled();
    res.json({
      usersFile: store.getDataPath(),
      mcpRegistryFile: registry.getFilePath(),
      mcpHttpPath,
      persistence: mongo ? "mongodb" : "file",
      ...(mongo ?
        {
          mongoDb: mongoDbName(),
          mongoCollection: mongoCollectionName(),
        }
      : {}),
      nosql: mongo
        ? "MongoDB: utilizadores + tokens + MCPs e registo (mcp_servers / mcp_templates) em documentos na coleção indicada."
        : "Coleção mcp_servers + mcp_templates em ficheiro JSON (defina MCP_HUB_MONGODB_URI para MongoDB).",
      hint:
        "Cliente MCP: X-MCP-Hub-User-Token = secret de API token. Templates admin (mcp_templates): utilizador preenche connection.headers sobre a definição base.",
    });
  });

  r.get("/api/system-logs", requireAdmin, (req: Request, res: Response) => {
    const raw = Number(req.query.limit ?? "200");
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(500, raw)) : 200;
    res.json({ entries: getSystemLogs(limit) });
  });

  r.get("/app.js", async (_req: Request, res: Response) => {
    if (!hubAdminEnabled) {
      res.status(404).end();
      return;
    }
    try {
      const body = await readFile(join(adminPublicDir(), "app.js"), "utf8");
      res.type("application/javascript; charset=utf-8").send(body);
    } catch {
      res.status(404).type("text/plain").send("// app.js em falta");
    }
  });

  r.get("/", async (_req: Request, res: Response) => {
    if (!hubAdminEnabled) {
      res.type("html").send(disabledSetupHtml);
      return;
    }
    try {
      const html = await readFile(join(adminPublicDir(), "index.html"), "utf8");
      res.type("html").send(html);
    } catch {
      res
        .status(500)
        .type("text/plain")
        .send("Ficheiro public/hub-admin/index.html em falta.");
    }
  });

  return r;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

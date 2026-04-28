import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type Router } from "express";
import type { McpRegistryStore } from "./mcpRegistryStore.js";
import { HubUserStore } from "./store.js";
import {
  adminCookieName,
  readAdminCookie,
  signAdminSession,
  verifyAdminSession,
} from "./session.js";
import { isMongoPersistenceEnabled, mongoCollectionName, mongoDbName } from "./mongoHubPersistence.js";
import type { HubConnectionOverrides } from "./types.js";

const SESSION_MS = 8 * 60 * 60 * 1000;

function adminPublicDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../public/hub-admin");
}

function parseJsonBody(req: Request): unknown {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body;
  }
  return {};
}

const ADMIN_NOT_CONFIGURED_MSG =
  "Painel admin não configurado. Define a variável de ambiente MCP_HUB_ADMIN_PASSWORD e reinicia o hub.";

const disabledSetupHtml = `<!DOCTYPE html>
<html lang="pt"><head><meta charset="utf-8"/><title>MCP Hub — Admin</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5;background:#0f1419;color:#e7ecf3}
code{background:#1a2332;padding:.15rem .4rem;border-radius:4px}</style></head><body>
<h1>Painel admin — configuração em falta</h1>
<p>O servidor HTTP está a correr, mas o admin <strong>não foi activado</strong>.</p>
<p>Define no ambiente do processo:</p>
<ul>
<li><code>MCP_HUB_ADMIN_PASSWORD</code> — palavra-passe para entrar nesta UI</li>
<li><code>MCP_HUB_ADMIN_SECRET</code> — opcional; cookie de sessão (senão usa a mesma palavra-passe)</li>
</ul>
<p>Em Docker, adiciona estas variáveis ao <code>docker-compose.yml</code> ou ao <code>.env</code> e recria o contentor.</p>
<p>Endpoint MCP: <code>GET …/mcp/health</code> indica <code>hubAdmin: "/hub-admin"</code> quando estiver activo.</p>
</body></html>`;

export function createHubAdminRouter(opts: {
  hubAdminEnabled: boolean;
  store: HubUserStore;
  registry: McpRegistryStore;
  adminPassword: string;
  sessionSecret: string;
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

  const requireAdmin = (req: Request, res: Response, next: () => void) => {
    if (!hubAdminEnabled) {
      adminNotReady(req, res);
      return;
    }
    const tok = readAdminCookie(req);
    if (!tok || !verifyAdminSession(sessionSecret, tok)) {
      res.status(401).json({ error: "Não autenticado." });
      return;
    }
    next();
  };

  r.post("/api/login", (req: Request, res: Response) => {
    if (!hubAdminEnabled) {
      adminNotReady(req, res);
      return;
    }
    const body = parseJsonBody(req) as { password?: string };
    const pw = String(body.password ?? "");
    if (!timingSafeEqualStr(adminPassword, pw)) {
      res.status(401).json({ error: "Palavra-passe inválida." });
      return;
    }
    const token = signAdminSession(sessionSecret, SESSION_MS);
    const maxAgeSec = Math.floor(SESSION_MS / 1000);
    res.setHeader(
      "Set-Cookie",
      `${adminCookieName()}=${encodeURIComponent(token)}; HttpOnly; Path=/hub-admin; SameSite=Lax; Max-Age=${maxAgeSec}`,
    );
    res.json({ ok: true });
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
    if (!tok || !verifyAdminSession(sessionSecret, tok)) {
      res.json({ ok: false, admin: false, configured: true });
      return;
    }
    res.json({ ok: true, admin: true, configured: true });
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
      res.status(500).json({ error: msg });
    }
  });

  r.delete("/api/users/:id", requireAdmin, async (req: Request, res: Response) => {
    await store.load();
    const ok = await store.deleteUser(String(req.params.id ?? ""));
    if (!ok) {
      res.status(404).json({ error: "Utilizador não encontrado." });
      return;
    }
    res.json({ ok: true });
  });

  r.put("/api/users/:id", requireAdmin, async (req: Request, res: Response) => {
    const body = parseJsonBody(req) as { label?: string };
    const label = String(body.label ?? "").trim();
    if (!label) {
      res.status(400).json({ error: "Campo label é obrigatório." });
      return;
    }
    await store.load();
    const updated = await store.updateUser(String(req.params.id ?? ""), label);
    if (!updated) {
      res.status(404).json({ error: "Utilizador não encontrado." });
      return;
    }
    res.json({ user: updated });
  });

  r.get(
    "/api/users/:id/tokens",
    requireAdmin,
    async (req: Request, res: Response) => {
      await store.load();
      const uid = String(req.params.id ?? "");
      if (!store.getUserById(uid)) {
        res.status(404).json({ error: "Utilizador não encontrado." });
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
      const uid = String(req.params.id ?? "");
      if (!store.getUserById(uid)) {
        res.status(404).json({ error: "Utilizador não encontrado." });
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
        res.status(400).json({ error: msg });
      }
    },
  );

  r.delete(
    "/api/users/:id/tokens/:tid",
    requireAdmin,
    async (req: Request, res: Response) => {
      await store.load();
      const uid = String(req.params.id ?? "");
      const tid = String(req.params.tid ?? "");
      const t = store.getTokenById(tid);
      if (!t || t.userId !== uid) {
        res.status(404).json({ error: "Token não encontrado." });
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
      const tid = String(req.params.tid ?? "");
      if (!store.getTokenById(tid)) {
        res.status(404).json({ error: "Token não encontrado." });
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
      const tid = String(req.params.tid ?? "");
      if (!store.getTokenById(tid)) {
        res.status(404).json({ error: "Token não encontrado." });
        return;
      }
      if (body.templateServerKey?.trim()) {
        const keys = await getMergedServerKeys();
        if (!keys.includes(body.templateServerKey.trim())) {
          res
            .status(400)
            .json({ error: "templateServerKey inválido ou não existe no hub." });
          return;
        }
      }
      if (body.templateId?.trim()) {
        await registry.load();
        const doc = await registry.getTemplateById(body.templateId.trim());
        if (!doc) {
          res.status(400).json({ error: "templateId inválido (template admin inexistente)." });
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
        res.status(400).json({ error: msg });
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
      const tid = String(req.params.tid ?? "");
      const mid = String(req.params.mid ?? "");
      const existing = store.getMcpById(mid);
      if (!existing || existing.tokenId !== tid) {
        res.status(404).json({ error: "MCP não encontrado." });
        return;
      }
      if (body.templateServerKey !== undefined && body.templateServerKey.trim()) {
        const keys = await getMergedServerKeys();
        if (!keys.includes(body.templateServerKey.trim())) {
          res
            .status(400)
            .json({ error: "templateServerKey inválido ou não existe no hub." });
          return;
        }
      }
      if (body.templateId !== undefined && body.templateId.trim()) {
        await registry.load();
        const doc = await registry.getTemplateById(body.templateId.trim());
        if (!doc) {
          res.status(400).json({ error: "templateId inválido (template admin inexistente)." });
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
        res.status(400).json({ error: msg });
      }
    },
  );

  r.delete(
    "/api/tokens/:tid/mcps/:mid",
    requireAdmin,
    async (req: Request, res: Response) => {
      await store.load();
      const tid = String(req.params.tid ?? "");
      const mid = String(req.params.mid ?? "");
      const existing = store.getMcpById(mid);
      if (!existing || existing.tokenId !== tid) {
        res.status(404).json({ error: "MCP não encontrado." });
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
        res.status(400).json({ error: "Campo def (JSON do servidor MCP base) é obrigatório." });
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
      res.status(400).json({ error: msg });
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
        res.status(404).json({ error: "Template não encontrado." });
        return;
      }
      res.json({ template: updated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
    }
  });

  r.delete("/api/mcp-templates/:id", requireAdmin, async (req: Request, res: Response) => {
    await registry.load();
    const ok = await registry.deleteTemplateById(String(req.params.id ?? ""));
    if (!ok) {
      res.status(404).json({ error: "Template não encontrado." });
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
        res.status(400).json({ error: "Campo def (JSON do servidor MCP) é obrigatório." });
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
      res.status(400).json({ error: msg });
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
        res.status(404).json({ error: "Documento não encontrado." });
        return;
      }
      res.json({ document: updated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
    }
  });

  r.delete("/api/mcp-registry/:id", requireAdmin, async (req: Request, res: Response) => {
    const ok = await registry.deleteById(String(req.params.id ?? ""));
    if (!ok) {
      res.status(404).json({ error: "Documento não encontrado." });
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

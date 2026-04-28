/** Painel MCP Hub — SPA com hash routes (#/inicio, …). */
const $ = (id) => document.getElementById(id);

/** Secret mostrado uma vez após criar token (evita perder o banner com re-render). */
let pendingNewKeySecret = null;

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

async function api(path, opts = {}) {
  const r = await fetch("/hub-admin/api" + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function parseRoute() {
  let h = location.hash || "#/inicio";
  h = h.replace(/^#/, "");
  if (!h.startsWith("/")) h = "/" + h;
  const parts = h.split("/").filter(Boolean);
  const name = parts[0] || "inicio";
  if (name === "mcps" && parts[1]) return { name: "mcps", tokenId: parts[1] };
  return { name, tokenId: null };
}

function navMark() {
  const cur = location.hash || "#/inicio";
  document.querySelectorAll("#sidebarNav a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    a.setAttribute("aria-current", href === cur ? "page" : "false");
  });
}

async function loadConfig() {
  try {
    const j = await api("/config");
    $("dataPath").textContent = j.usersFile || "";
    $("registryPath").textContent = j.mcpRegistryFile || "";
  } catch {
    $("dataPath").textContent = "?";
    $("registryPath").textContent = "?";
  }
}

function showApp() {
  $("loginSection").classList.add("hidden");
  $("appSection").classList.remove("hidden");
  $("main").classList.add("main--app");
  if (!location.hash || location.hash === "#") {
    location.hash = "#/inicio";
  }
}

function tplOptsHtml(tplList) {
  if (!tplList?.length) {
    return '<option value="">(sem templates — cria na página Templates)</option>';
  }
  return tplList
    .map(
      (x) =>
        `<option value="${esc(x._id)}" data-hint="${esc((x.accessHeaderKeys || []).join(", "))}">${esc(x.label)} (${esc(x.key)})</option>`,
    )
    .join("");
}

function serverOptsHtml(servers) {
  if (!servers?.length) {
    return '<option value="">(sem chaves no catálogo)</option>';
  }
  return servers.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
}

function wireMcpAddPanel(root, tokenId, servers, tplList) {
  const modeSel = root.querySelector(".mcp-mode");
  const directF = root.querySelector(".mcp-direct-fields");
  const catF = root.querySelector(".mcp-catalog-fields");
  const admF = root.querySelector(".mcp-admintpl-fields");
  const tplSel = root.querySelector(".mcp-admin-template-id");
  const tplHint = root.querySelector(".mcp-tpl-hint");
  if (!modeSel || !directF || !catF || !admF || !tplSel || !tplHint) return;

  const syncTplHint = () => {
    const opt = tplSel.selectedOptions[0];
    const h = opt ? opt.getAttribute("data-hint") : "";
    tplHint.textContent = h
      ? `Sugestão de cabeçalhos: ${h}`
      : "Preenche os valores reais de API / URL no JSON abaixo.";
  };
  tplSel.onchange = syncTplHint;
  syncTplHint();

  const syncMode = () => {
    const v = modeSel.value;
    directF.classList.toggle("hidden", v !== "direct");
    catF.classList.toggle("hidden", v !== "catalog");
    admF.classList.toggle("hidden", v !== "admintpl");
  };
  modeSel.onchange = () => {
    syncMode();
    if (modeSel.value === "admintpl") syncTplHint();
  };
  syncMode();

  root.querySelector(".btn-add-mcp")?.addEventListener("click", async () => {
    let body = {};
    try {
      if (modeSel.value === "direct") {
        const url = root.querySelector(".mcp-url").value.trim();
        const headers = JSON.parse(root.querySelector(".mcp-headers").value || "{}");
        const env = JSON.parse(root.querySelector(".mcp-env").value || "{}");
        body = {
          label: root.querySelector(".mcp-label").value.trim() || undefined,
          url,
          headers,
          env: Object.keys(env).length ? env : undefined,
        };
      } else if (modeSel.value === "catalog") {
        const templateServerKey = root.querySelector(".mcp-catalog-key").value.trim();
        const connection = JSON.parse(root.querySelector(".mcp-conn").value || "{}");
        body = {
          label: root.querySelector(".mcp-label").value.trim() || undefined,
          templateServerKey,
          connection,
        };
      } else {
        const templateId = tplSel.value.trim();
        if (!templateId) {
          alert("Escolhe um template administrativo.");
          return;
        }
        const headers = JSON.parse(root.querySelector(".mcp-access-headers").value || "{}");
        body = {
          label: root.querySelector(".mcp-label").value.trim() || undefined,
          templateId,
          connection: { headers },
        };
      }
    } catch {
      alert("JSON inválido.");
      return;
    }
    try {
      await api(`/tokens/${tokenId}/mcps`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await render();
    } catch (e) {
      alert(e.message);
    }
  });
}

async function renderInicio(view) {
  await loadConfig();
  view.innerHTML = `
    <div class="panel">
      <p class="section-lead">Escolhe uma secção na barra lateral. Os ficheiros de dados aparecem acima.</p>
      <div class="quick-grid cols-2">
        <a class="card-link" href="#/utilizadores"><strong>Utilizadores</strong>Criar, editar etiqueta e apagar contas.</a>
        <a class="card-link" href="#/templates"><strong>Templates MCP</strong>Definições base e variáveis sugeridas.</a>
        <a class="card-link" href="#/catalogo"><strong>Catálogo MCP</strong>Entradas <code>mcp_servers</code> no registo JSON.</a>
        <a class="card-link" href="#/api-keys"><strong>API keys</strong>Criar e revogar tokens por utilizador.</a>
        <a class="card-link" href="#/mcps"><strong>MCPs por API key</strong>Ligar MCPs a um token e editar variáveis.</a>
      </div>
    </div>`;
}

async function renderUtilizadores(view) {
  const { users } = await api("/users");
  view.innerHTML = `
    <div class="panel">
      <h3 class="section-title">Novo utilizador</h3>
      <form id="formCreateUser" class="row cols-2">
        <div>
          <label for="nuLabel">Etiqueta</label>
          <input type="text" id="nuLabel" placeholder="Equipa A" autocomplete="organization" />
        </div>
        <div class="btn-row" style="align-self:end;">
          <button type="submit">Criar</button>
        </div>
      </form>
      <p id="uErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>
    <div class="panel">
      <h3 class="section-title">Utilizadores</h3>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Etiqueta</th><th>ID</th><th>Criado</th><th>Acções</th></tr></thead>
          <tbody>
            ${users
              .map(
                (u) => `
              <tr>
                <td>${esc(u.label)}</td>
                <td><code>${esc(u.id)}</code></td>
                <td>${esc(u.createdAt || "")}</td>
                <td>
                  <div class="btn-row" style="margin:0;">
                    <button type="button" class="secondary btn-edit-u" data-id="${esc(u.id)}" data-label="${esc(u.label)}">Editar</button>
                    <button type="button" class="danger btn-del-u" data-id="${esc(u.id)}">Apagar</button>
                  </div>
                </td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>`;

  $("formCreateUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("uErr").classList.add("hidden");
    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({ label: $("nuLabel").value }),
      });
      $("nuLabel").value = "";
      await render();
    } catch (err) {
      $("uErr").textContent = err.message;
      $("uErr").classList.remove("hidden");
    }
  });

  view.querySelectorAll(".btn-edit-u").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const lab = prompt("Nova etiqueta:", btn.getAttribute("data-label") || "");
      if (lab == null || !lab.trim()) return;
      try {
        await api(`/users/${id}`, { method: "PUT", body: JSON.stringify({ label: lab.trim() }) });
        await render();
      } catch (e) {
        alert(e.message);
      }
    });
  });

  view.querySelectorAll(".btn-del-u").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!confirm("Apagar utilizador e todos os tokens e MCPs?")) return;
      try {
        await api(`/users/${id}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function renderTemplates(view) {
  const { templates } = await api("/mcp-templates");
  const defSample = `{
  "streamableHttp": {
    "url": "https://exemplo.mcp.eship.com.br/mcp",
    "headers": {
      "X-Eship-Api-Key": "\${ESHIP_API_KEY}",
      "X-Eship-Api-Base-Url": "\${ESHIP_API_BASE_URL}"
    }
  }
}`;
  view.innerHTML = `
    <div class="panel">
      <h3 class="section-title">Novo template</h3>
      <div class="row cols-2">
        <div><label for="tplKey">Chave única</label><input type="text" id="tplKey" placeholder="meu-template" /></div>
        <div><label for="tplLabel">Etiqueta</label><input type="text" id="tplLabel" placeholder="Nome legível" /></div>
      </div>
      <label for="tplDesc">Descrição (opcional)</label>
      <input type="text" id="tplDesc" placeholder="Instruções para quem preenche os headers." />
      <label for="tplHeaderKeys">Cabeçalhos sugeridos (vírgula)</label>
      <input type="text" id="tplHeaderKeys" placeholder="X-Eship-Api-Key, X-Eship-Api-Base-Url" />
      <label for="tplDef">Definição MCP base (JSON)</label>
      <textarea id="tplDef" rows="10">${esc(defSample)}</textarea>
      <div class="btn-row">
        <button type="button" id="btnTplSave">Guardar template</button>
      </div>
      <p id="tplErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>
    <div class="panel">
      <h3 class="section-title">Templates existentes</h3>
      <ul class="users" id="tplListUl"></ul>
    </div>`;

  const ul = $("tplListUl");
  ul.innerHTML = (templates || [])
    .map(
      (d) => `
    <li class="user" data-tpl="${esc(d._id)}">
      <h4 style="margin:0 0 0.5rem;"><code>${esc(d.key)}</code> — ${esc(d.label)}</h4>
      <p class="sub" style="margin:0;">${esc(d.description || "")}</p>
      <p class="sub">Cabeçalhos: <code>${esc((d.accessHeaderKeys || []).join(", ") || "—")}</code></p>
      <div class="btn-row">
        <button type="button" class="secondary btn-tpl-edit">Editar (JSON)</button>
        <button type="button" class="danger btn-tpl-del">Apagar</button>
      </div>
    </li>`,
    )
    .join("");

  $("btnTplSave").onclick = async () => {
    $("tplErr").classList.add("hidden");
    let def;
    try {
      def = JSON.parse($("tplDef").value || "{}");
    } catch {
      $("tplErr").textContent = "JSON inválido.";
      $("tplErr").classList.remove("hidden");
      return;
    }
    const keysRaw = $("tplHeaderKeys").value.trim();
    const accessHeaderKeys = keysRaw
      ? keysRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    try {
      await api("/mcp-templates", {
        method: "POST",
        body: JSON.stringify({
          key: $("tplKey").value,
          label: $("tplLabel").value,
          description: $("tplDesc").value.trim() || undefined,
          accessHeaderKeys,
          def,
        }),
      });
      await render();
    } catch (e) {
      $("tplErr").textContent = e.message;
      $("tplErr").classList.remove("hidden");
    }
  };

  ul.querySelectorAll(".btn-tpl-del").forEach((btn) => {
    const li = btn.closest("li");
    const id = li.getAttribute("data-tpl");
    btn.onclick = async () => {
      if (!confirm("Apagar este template?")) return;
      try {
        await api(`/mcp-templates/${id}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    };
  });

  ul.querySelectorAll(".btn-tpl-edit").forEach((btn) => {
    const li = btn.closest("li");
    const id = li.getAttribute("data-tpl");
    const doc = (templates || []).find((x) => x._id === id);
    btn.onclick = async () => {
      if (!doc) return;
      const raw = prompt(
        "JSON: key, label, description, accessHeaderKeys[], def",
        JSON.stringify(
          {
            key: doc.key,
            label: doc.label,
            description: doc.description,
            accessHeaderKeys: doc.accessHeaderKeys,
            def: doc.def,
          },
          null,
          2,
        ),
      );
      if (raw == null) return;
      let patch;
      try {
        patch = JSON.parse(raw);
      } catch {
        alert("JSON inválido.");
        return;
      }
      try {
        await api(`/mcp-templates/${id}`, { method: "PUT", body: JSON.stringify(patch) });
        await render();
      } catch (e) {
        alert(e.message);
      }
    };
  });
}

async function renderCatalogo(view) {
  const { documents } = await api("/mcp-registry");
  const defSample = `{
  "streamableHttp": {
    "url": "https://exemplo.mcp.eship.com.br/mcp",
    "headers": { "X-Eship-Api-Key": "\${ESHIP_API_KEY}" }
  }
}`;
  view.innerHTML = `
    <div class="panel">
      <h3 class="section-title">Novo documento no registo</h3>
      <div class="row cols-2">
        <div><label for="regKey">Chave</label><input type="text" id="regKey" /></div>
        <div><label for="regLabel">Etiqueta</label><input type="text" id="regLabel" /></div>
      </div>
      <label for="regDef">Definição MCP (JSON)</label>
      <textarea id="regDef" rows="10">${esc(defSample)}</textarea>
      <div class="btn-row"><button type="button" id="btnRegSave">Guardar</button></div>
      <p id="regErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>
    <div class="panel">
      <h3 class="section-title">Documentos</h3>
      <ul class="users" id="regUl"></ul>
    </div>`;

  $("regUl").innerHTML = (documents || [])
    .map(
      (d) => `
    <li class="user" data-doc="${esc(d._id)}">
      <h4 style="margin:0 0 0.5rem;"><code>${esc(d.key)}</code> — ${esc(d.label || "")}</h4>
      <p class="sub">_id: ${esc(d._id)}</p>
      <div class="btn-row">
        <button type="button" class="secondary btn-reg-edit">Editar def JSON</button>
        <button type="button" class="danger btn-reg-del">Apagar</button>
      </div>
    </li>`,
    )
    .join("");

  $("btnRegSave").onclick = async () => {
    $("regErr").classList.add("hidden");
    let def;
    try {
      def = JSON.parse($("regDef").value || "{}");
    } catch {
      $("regErr").textContent = "JSON inválido.";
      $("regErr").classList.remove("hidden");
      return;
    }
    try {
      await api("/mcp-registry", {
        method: "POST",
        body: JSON.stringify({
          key: $("regKey").value,
          label: $("regLabel").value,
          def,
        }),
      });
      await render();
    } catch (e) {
      $("regErr").textContent = e.message;
      $("regErr").classList.remove("hidden");
    }
  };

  $("regUl").querySelectorAll(".btn-reg-del").forEach((btn) => {
    const li = btn.closest("li");
    const id = li.getAttribute("data-doc");
    btn.onclick = async () => {
      if (!confirm("Remover do registo NoSQL?")) return;
      try {
        await api(`/mcp-registry/${id}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    };
  });

  $("regUl").querySelectorAll(".btn-reg-edit").forEach((btn) => {
    const li = btn.closest("li");
    const id = li.getAttribute("data-doc");
    const doc = (documents || []).find((x) => x._id === id);
    btn.onclick = async () => {
      if (!doc) return;
      const raw = prompt("JSON def:", JSON.stringify(doc.def, null, 2));
      if (raw == null) return;
      let def;
      try {
        def = JSON.parse(raw);
      } catch {
        alert("JSON inválido.");
        return;
      }
      try {
        await api(`/mcp-registry/${id}`, { method: "PUT", body: JSON.stringify({ def }) });
        await render();
      } catch (e) {
        alert(e.message);
      }
    };
  });
}

function flattenTokens(users) {
  const rows = [];
  for (const u of users || []) {
    for (const t of u.tokens || []) {
      rows.push({ ...t, userLabel: u.label, userId: u.id });
    }
  }
  return rows;
}

async function renderApiKeys(view) {
  const secretBanner = pendingNewKeySecret;
  pendingNewKeySecret = null;
  const { users } = await api("/users");
  const rows = flattenTokens(users);
  const hasUsers = (users || []).length > 0;
  view.innerHTML = `
    <div class="panel">
      <h3 class="section-title">Nova API key</h3>
      ${
        hasUsers
          ? ""
          : `<p class="feedback" role="status">Cria primeiro um utilizador em <a href="#/utilizadores">Utilizadores</a>.</p>`
      }
      <div class="row cols-2">
        <div>
          <label for="keyUser">Utilizador</label>
          <select id="keyUser" ${hasUsers ? "" : "disabled"}>${(users || [])
            .map((u) => `<option value="${esc(u.id)}">${esc(u.label)}</option>`)
            .join("")}</select>
        </div>
        <div>
          <label for="keyLabel">Etiqueta do token</label>
          <input type="text" id="keyLabel" placeholder="default" ${hasUsers ? "" : "disabled"} />
        </div>
      </div>
      <div class="btn-row"><button type="button" id="btnKeyCreate" ${hasUsers ? "" : "disabled"}>Gerar API key</button></div>
      <div id="keySecretWrap" class="${secretBanner ? "" : "hidden"}">
        <p class="feedback feedback--ok">Guarda o <strong>secret</strong> — não volta a aparecer. Usa no cabeçalho <code>X-MCP-Hub-User-Token</code>.</p>
        <div class="token-box" id="keySecretBox" tabindex="0" role="status">${secretBanner ? esc(secretBanner) : ""}</div>
      </div>
      <p id="keyErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>
    <div class="panel">
      <h3 class="section-title">API keys existentes</h3>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Utilizador</th><th>Etiqueta</th><th>ID do token</th><th>Criado</th><th></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (t) => `
              <tr>
                <td>${esc(t.userLabel)}</td>
                <td>${esc(t.label)}</td>
                <td><code>${esc(t.id)}</code></td>
                <td>${esc(t.createdAt || "")}</td>
                <td>
                  <div class="btn-row" style="margin:0;">
                    <a class="secondary" href="#/mcps/${esc(t.id)}" style="display:inline-flex;padding:0.4rem 0.75rem;border-radius:6px;text-decoration:none;border:1px solid var(--border-strong);font-size:0.8125rem;">MCPs</a>
                    <button type="button" class="danger btn-revoke" data-uid="${esc(t.userId)}" data-tid="${esc(t.id)}">Revogar</button>
                  </div>
                </td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>`;

  $("btnKeyCreate").onclick = async () => {
    $("keyErr").classList.add("hidden");
    $("keySecretWrap").classList.add("hidden");
    try {
      const j = await api(`/users/${$("keyUser").value}/tokens`, {
        method: "POST",
        body: JSON.stringify({ label: $("keyLabel").value || "default" }),
      });
      pendingNewKeySecret = j.secret;
      await render();
    } catch (e) {
      $("keyErr").textContent = e.message;
      $("keyErr").classList.remove("hidden");
    }
  };

  view.querySelectorAll(".btn-revoke").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-uid");
      const tid = btn.getAttribute("data-tid");
      if (!confirm("Revogar esta API key e todos os MCPs associados?")) return;
      try {
        await api(`/users/${uid}/tokens/${tid}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function renderMcps(view, tokenId) {
  const [{ servers }, tplRes, { users }] = await Promise.all([
    api("/servers"),
    api("/mcp-templates").catch(() => ({ templates: [] })),
    api("/users"),
  ]);
  const tplList = tplRes.templates || [];
  const flat = flattenTokens(users);
  const tplOpts = tplOptsHtml(tplList);
  const srvOpts = serverOptsHtml(servers);

  if (!tokenId) {
    view.innerHTML = `
      <div class="panel">
        <h3 class="section-title">Seleccionar API key</h3>
        <p class="section-lead">Escolhe o token para gerir os MCPs vinculados (URL, catálogo ou template admin + variáveis).</p>
        <label for="pickTok">Token</label>
        <select id="pickTok">
          <option value="">— Escolher —</option>
          ${flat
            .map(
              (t) =>
                `<option value="${esc(t.id)}">${esc(t.userLabel)} · ${esc(t.label)} (${esc(t.id).slice(0, 8)}…)</option>`,
            )
            .join("")}
        </select>
        <div class="btn-row">
          <button type="button" id="btnGoMcps">Abrir</button>
        </div>
      </div>`;
    $("btnGoMcps").onclick = () => {
      const v = $("pickTok").value;
      if (!v) {
        alert("Escolhe uma API key.");
        return;
      }
      location.hash = "#/mcps/" + v;
    };
    return;
  }

  const tok = flat.find((x) => x.id === tokenId);
  const { mcps } = await api(`/tokens/${tokenId}/mcps`);

  const mcpRows = (mcps || [])
    .map(
      (m) => `
    <li class="mcp-row" data-mid="${esc(m.id)}">
      <div class="mcp-row__main">
        <strong>${esc(m.label || m.id)}</strong>
        ${
          m.url
            ? `<span class="sub"> · URL directa</span>`
            : m.templateId
              ? (() => {
                  const tt = tplList.find((x) => x._id === m.templateId);
                  return `<span class="sub"> · template: ${esc(tt ? tt.label : m.templateId)}</span>`;
                })()
              : `<span class="sub"> · catálogo: ${esc(m.templateServerKey || "")}</span>`
        }
      </div>
      <div class="mcp-row__actions">
        <button type="button" class="secondary btn-mcp-edit" data-mid="${esc(m.id)}">Editar JSON</button>
        <button type="button" class="danger btn-mcp-del" data-mid="${esc(m.id)}">Remover</button>
      </div>
    </li>`,
    )
    .join("");

  view.innerHTML = `
    <div class="panel">
      <p class="section-lead">Token: <strong>${esc(tok ? `${tok.userLabel} · ${tok.label}` : tokenId)}</strong>
        · <a href="#/mcps">Trocar API key</a></p>
      <h3 class="section-title">MCPs vinculados</h3>
      <ul class="links">${mcpRows || '<li class="sub">Nenhum MCP.</li>'}</ul>
    </div>
    <div class="panel mcp-add-root">
      <h3 class="section-title">Adicionar MCP</h3>
      <div class="row cols-2">
        <div>
          <label class="label-like">Modo</label>
          <select class="mcp-mode">
            <option value="direct">URL directa</option>
            <option value="catalog">Catálogo global</option>
            <option value="admintpl">Template administrativo</option>
          </select>
        </div>
        <div>
          <label class="label-like">Etiqueta (opcional)</label>
          <input type="text" class="mcp-label" placeholder="ex. produção" />
        </div>
      </div>
      <div class="mcp-direct-fields">
        <label class="label-like">URL</label>
        <input type="text" class="mcp-url" placeholder="https://…/mcp" />
        <label class="label-like" style="margin-top:0.65rem;">Headers (JSON)</label>
        <textarea class="mcp-headers" rows="3">{}</textarea>
        <label class="label-like" style="margin-top:0.65rem;">Env (JSON, opcional)</label>
        <textarea class="mcp-env" rows="2">{}</textarea>
      </div>
      <div class="mcp-catalog-fields hidden">
        <label class="label-like">Chave no hub</label>
        <select class="mcp-catalog-key">${srvOpts}</select>
        <label class="label-like" style="margin-top:0.65rem;">Connection (JSON)</label>
        <textarea class="mcp-conn" rows="4">${esc(JSON.stringify({ headers: {}, env: {} }, null, 2))}</textarea>
      </div>
      <div class="mcp-admintpl-fields hidden">
        <label class="label-like">Template</label>
        <select class="mcp-admin-template-id">${tplOpts}</select>
        <p class="sub mcp-tpl-hint" role="note"></p>
        <label class="label-like" style="margin-top:0.65rem;">Cabeçalhos de acesso (JSON)</label>
        <textarea class="mcp-access-headers" rows="4">{}</textarea>
      </div>
      <div class="btn-row"><button type="button" class="btn-add-mcp">Adicionar MCP</button></div>
    </div>`;

  const addRoot = view.querySelector(".mcp-add-root");
  wireMcpAddPanel(addRoot, tokenId, servers, tplList);

  view.querySelectorAll(".btn-mcp-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mid = btn.getAttribute("data-mid");
      if (!confirm("Remover este MCP?")) return;
      try {
        await api(`/tokens/${tokenId}/mcps/${mid}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    });
  });

  view.querySelectorAll(".btn-mcp-edit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mid = btn.getAttribute("data-mid");
      const m = (mcps || []).find((x) => x.id === mid);
      if (!m) return;
      const raw = prompt(
        "Editar MCP (JSON): label, url, headers, env, templateServerKey, templateId, connection",
        JSON.stringify(
          {
            label: m.label,
            url: m.url,
            headers: m.headers,
            env: m.env,
            templateServerKey: m.templateServerKey,
            templateId: m.templateId,
            connection: m.connection,
          },
          null,
          2,
        ),
      );
      if (raw == null) return;
      let patch;
      try {
        patch = JSON.parse(raw);
      } catch {
        alert("JSON inválido.");
        return;
      }
      try {
        await api(`/tokens/${tokenId}/mcps/${mid}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        });
        await render();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function render() {
  navMark();
  const route = parseRoute();
  const vt = $("viewTitle");
  const view = $("appView");
  if (!view || !vt) return;

  const titles = {
    inicio: "Início",
    utilizadores: "Utilizadores",
    templates: "Templates MCP",
    catalogo: "Catálogo MCP",
    "api-keys": "API keys",
    mcps: "MCPs por API key",
  };
  vt.textContent = titles[route.name] || "Painel";

  try {
    switch (route.name) {
      case "inicio":
        await renderInicio(view);
        break;
      case "utilizadores":
        await renderUtilizadores(view);
        break;
      case "templates":
        await renderTemplates(view);
        break;
      case "catalogo":
        await renderCatalogo(view);
        break;
      case "api-keys":
        await renderApiKeys(view);
        break;
      case "mcps":
        await renderMcps(view, route.tokenId);
        break;
      default:
        location.hash = "#/inicio";
    }
  } catch (e) {
    view.innerHTML = `<p class="feedback feedback--err">${esc(e.message)}</p>`;
  }
}

async function checkMe() {
  try {
    const j = await api("/me");
    if (j.admin) {
      showApp();
      await loadConfig();
      await render();
      $("appMain")?.focus({ preventScroll: true });
    }
  } catch {
    /* não autenticado */
  }
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginErr").classList.add("hidden");
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ password: $("adminPw").value }),
    });
    showApp();
    await loadConfig();
    await render();
    $("appMain")?.focus({ preventScroll: true });
  } catch (err) {
    $("loginErr").textContent = err.message;
    $("loginErr").classList.remove("hidden");
  }
});

$("btnLogout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  $("appSection").classList.add("hidden");
  $("loginSection").classList.remove("hidden");
  $("main").classList.remove("main--app");
  location.hash = "";
  $("adminPw")?.focus();
});

window.addEventListener("hashchange", () => {
  if (!$("appSection")?.classList.contains("hidden")) {
    void render();
  }
});

void checkMe();

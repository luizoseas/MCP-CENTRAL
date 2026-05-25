/** Painel MCP Hub — SPA com hash routes (#/inicio, …). */
const $ = (id) => document.getElementById(id);

/** Secret mostrado uma vez após criar token (evita perder o banner com re-render). */
let pendingNewKeySecret = null;

/** Última resposta de GET /api/config (caminho MCP, …). */
let hubConfig = {
  mcpHttpPath: "/mcp",
};

/** Modelo por padrão ao vincular MCP por template administrativo (substitui os valores de exemplo). */
const MCP_ADMIN_ACCESS_JSON_DEFAULT = JSON.stringify(
  {
    headers: {
      "X-Eship-Api-Key": "suapikeyaqui",
      "X-Eship-Api-Base-Url": "https://seusistemaqui.eship.com.br/v3",
    },
    env: {},
  },
  null,
  2,
);

/**
 * JSON do campo «template administrativo» → `connection` da API.
 * Aceita `{"headers":{...},"env":{}}` ou o formato legado (só o mapa de cabeçalhos).
 */
function parseAdminTemplateConnectionJson(text) {
  const raw = JSON.parse(String(text ?? "").trim() || "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("JSON inválido.");
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, "headers") &&
    raw.headers !== null &&
    typeof raw.headers === "object" &&
    !Array.isArray(raw.headers)
  ) {
    const headers = raw.headers;
    const env =
      raw.env !== null &&
      typeof raw.env === "object" &&
      !Array.isArray(raw.env) &&
      Object.keys(raw.env).length > 0
        ? raw.env
        : undefined;
    return env ? { headers, env } : { headers };
  }
  return { headers: raw };
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/** Igualdade de IDs no painel: trim; UUIDs sem distinguir maiúsculas/minúsculas. */
function sameEntityId(a, b) {
  const ta = String(a ?? "").trim();
  const tb = String(b ?? "").trim();
  if (ta === tb) return true;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuid.test(ta) && uuid.test(tb) && ta.toLowerCase() === tb.toLowerCase();
}

async function api(path, opts = {}) {
  const r = await fetch("/hub-admin/api" + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j.error || r.statusText || "Erro");
    const code = typeof j.code === "string" ? ` [${j.code}]` : "";
    const id = typeof j.errorId === "string" ? ` [${j.errorId}]` : "";
    const detail = typeof j.detail === "string" && j.detail ? ` — ${j.detail}` : "";
    throw new Error(`${msg}${code}${id}${detail}`);
  }
  return j;
}

/** Navegação do selector «MCPs por API key» (#/mcps sem token). Chamado por delegação em #appView ou Enter no #pickTok. */
function tryNavigateMcpsPicker() {
  const pick = $("pickTok");
  const errEl = $("pickTokErr");
  if (!pick) return;
  const v = pick.value.trim();
  if (!v) {
    if (errEl) {
      errEl.textContent = "Escolha uma API key na lista.";
      errEl.classList.remove("hidden");
    }
    pick.focus();
    return;
  }
  if (errEl) errEl.classList.add("hidden");
  const next = `#/mcps/${v}`;
  if (location.hash === next) {
    void render();
  } else {
    location.hash = next;
  }
}

function parseRoute() {
  let h = location.hash || "#/inicio";
  h = h.replace(/^#/, "");
  if (!h.startsWith("/")) h = "/" + h;
  const qIdx = h.indexOf("?");
  const qp = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : "");
  if (qIdx >= 0) h = h.slice(0, qIdx);
  const parts = h.split("/").filter(Boolean);
  const name = parts[0] || "inicio";
  const empty = { tokenId: null, mcpId: null, userId: null, templateId: null, docId: null, query: qp };
  const seg = (i) => (typeof parts[i] === "string" ? parts[i].trim() : "");

  if (name === "mcps" && seg(1)) {
    if (seg(2) === "edit" && seg(3)) {
      return { ...empty, name: "mcp-edit", tokenId: seg(1), mcpId: seg(3) };
    }
    return { ...empty, name: "mcps", tokenId: seg(1) };
  }
  if (name === "usuarios" && seg(1) === "edit" && seg(2)) {
    return { ...empty, name: "user-edit", userId: seg(2) };
  }
  if (name === "templates" && seg(1) === "edit" && seg(2)) {
    return { ...empty, name: "template-edit", templateId: seg(2) };
  }
  if (name === "catalogo" && seg(1) === "edit" && seg(2)) {
    return { ...empty, name: "catalog-edit", docId: seg(2) };
  }

  return { ...empty, name };
}

function navMark() {
  const cur = location.hash || "#/inicio";
  document.querySelectorAll("#sidebarNav a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    let active = href === cur;
    if (!active && href !== "#/inicio" && cur.startsWith(`${href}/`)) {
      active = true;
    }
    if (!active && href === "#/mcps" && (cur.startsWith("#/mcps/") || cur === "#/mcps")) {
      active = true;
    }
    a.setAttribute("aria-current", active ? "page" : "false");
  });
}

async function loadConfig() {
  try {
    const j = await api("/config");
    hubConfig.mcpHttpPath = typeof j.mcpHttpPath === "string" && j.mcpHttpPath ? j.mcpHttpPath : "/mcp";
  } catch {
    hubConfig.mcpHttpPath = "/mcp";
  }
}

function mcpEndpointUrl() {
  const path = hubConfig.mcpHttpPath.startsWith("/") ? hubConfig.mcpHttpPath : `/${hubConfig.mcpHttpPath}`;
  return `${window.location.origin}${path}`;
}

function showApp() {
  $("loginSection").classList.add("hidden");
  $("appSection").classList.remove("hidden");
  $("main").classList.add("main--app");
  if (!location.hash || location.hash === "#") {
    location.hash = "#/inicio";
  }
}

function tplOptsHtml(tplList, selectedId) {
  if (!tplList?.length) {
    return '<option value="">(sem templates — cria na página Templates)</option>';
  }
  return tplList
    .map(
      (x) =>
        `<option value="${esc(x._id)}" data-hint="${esc((x.accessHeaderKeys || []).join(", "))}"${x._id === selectedId ? " selected" : ""}>${esc(x.label)} (${esc(x.key)})</option>`,
    )
    .join("");
}

function serverOptsHtml(servers, selectedKey) {
  if (!servers?.length) {
    return '<option value="">(sem chaves no catálogo)</option>';
  }
  return servers
    .map((s) => `<option value="${esc(s)}"${s === selectedKey ? " selected" : ""}>${esc(s)}</option>`)
    .join("");
}

/**
 * Formulário “Adicionar MCP” (POST) ou “Editar MCP” (PUT).
 * @param {object | null} edit — `{ mcpId }` para PUT; `null` para POST.
 */
function wireMcpFormPanel(root, tokenId, servers, tplList, edit) {
  const modeSel = root.querySelector(".mcp-mode");
  const directF = root.querySelector(".mcp-direct-fields");
  const catF = root.querySelector(".mcp-catalog-fields");
  const admF = root.querySelector(".mcp-admintpl-fields");
  const tplSel = root.querySelector(".mcp-admin-template-id");
  const tplHint = root.querySelector(".mcp-tpl-hint");
  const saveBtn = edit ? root.querySelector(".btn-save-mcp") : root.querySelector(".btn-add-mcp");
  if (!modeSel || !directF || !catF || !admF || !tplSel || !tplHint || !saveBtn) return;

  const syncTplHint = () => {
    const opt = tplSel.selectedOptions[0];
    const h = opt ? opt.getAttribute("data-hint") : "";
    tplHint.textContent = h
      ? `Sugestão de cabeçalhos: ${h}`
      : "Preencha os valores reais de API / URL no JSON abaixo.";
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

  saveBtn.addEventListener("click", async () => {
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
          alert("Escolha um template administrativo.");
          return;
        }
        const connection = parseAdminTemplateConnectionJson(
          root.querySelector(".mcp-access-headers").value,
        );
        body = {
          label: root.querySelector(".mcp-label").value.trim() || undefined,
          templateId,
          connection,
        };
      }
    } catch {
      alert("JSON inválido.");
      return;
    }
    try {
      if (edit) {
        await api(`/tokens/${tokenId}/mcps/${edit.mcpId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        location.hash = `#/mcps/${tokenId}`;
      } else {
        await api(`/tokens/${tokenId}/mcps`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        await render();
      }
    } catch (e) {
      alert(e.message);
    }
  });
}

function wireMcpAddPanel(root, tokenId, servers, tplList) {
  wireMcpFormPanel(root, tokenId, servers, tplList, null);
}

async function renderInicio(view) {
  await loadConfig();
  view.innerHTML = `
    <div class="panel">
      <p class="section-lead">Escolha uma seção na barra lateral.</p>
      <div class="quick-grid cols-2">
        <a class="card-link" href="#/clientes"><strong>Como conectar?</strong>Passo a passo com URL do hub e header do token.</a>
        <a class="card-link" href="#/usuarios"><strong>Usuários</strong>Criar, editar etiqueta e apagar contas.</a>
        <a class="card-link" href="#/templates"><strong>Templates MCP</strong>Definições base e variáveis sugeridas.</a>
        <a class="card-link" href="#/catalogo"><strong>Catálogo MCP</strong>Entradas <code>mcp_servers</code> no registro JSON.</a>



        <a class="card-link" href="#/logs"><strong>Logs do sistema</strong>Ver falhas do painel e da conexão aos MCPs com código e ID único.</a>
      </div>
    </div>`;
}

async function renderSystemLogs(view, filterTokenId) {
  const qs = filterTokenId
    ? `/system-logs?limit=250&tokenId=${encodeURIComponent(filterTokenId)}`
    : "/system-logs?limit=250";
  const j = await api(qs);
  const entries = Array.isArray(j.entries) ? j.entries : [];

  function formatTs(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${dd}/${mm}/${yy} ${hh}:${mi}:${ss}`;
    } catch {
      return iso;
    }
  }

  function levelBadge(level) {
    if (level === "error") return '<span class="log-badge log-badge--error">falha</span>';
    if (level === "info") return '<span class="log-badge log-badge--info">sucesso</span>';
    return `<span class="log-badge">${esc(level || "")}</span>`;
  }

  view.innerHTML = `
    <div class="panel">
      <h3 class="section-title">Logs do sistema</h3>
      ${filterTokenId
        ? `<p class="feedback feedback--ok" style="margin-bottom:0.75rem;">Filtrado por API key <code>${esc(filterTokenId)}</code>. <a href="#/logs">Ver todos os logs</a> · <a href="#/api-keys">Voltar às API keys</a></p>`
        : ""}
      <p class="section-lead">Cada falha retorna <code>code</code> + <code>errorId</code>. Use ambos para rastrear no painel e no backend.</p>

      <div class="log-filters">
        <div class="log-filter-group">
          <label for="logFilterLevel">Nível</label>
          <select id="logFilterLevel">
            <option value="">Todos</option>
            <option value="error">Falha</option>
            <option value="info">Sucesso</option>
          </select>
        </div>
        <div class="log-filter-group log-filter-group--grow">
          <label for="logFilterMsg">Mensagem</label>
          <input type="text" id="logFilterMsg" placeholder="Pesquisar na mensagem ou detalhe…" />
        </div>
        <div class="log-filter-group">
          <label for="logFilterFrom">De</label>
          <input type="date" id="logFilterFrom" />
        </div>
        <div class="log-filter-group">
          <label for="logFilterTo">Até</label>
          <input type="date" id="logFilterTo" />
        </div>
        <div class="log-filter-group log-filter-group--actions">
          <button type="button" id="btnClearFilters" class="secondary">Limpar</button>
          <button type="button" id="btnReloadLogs">Atualizar</button>
        </div>
      </div>

      <p class="sub" id="logCount" style="margin:0.5rem 0 0;"></p>
      <div class="data-table-wrap">
        <table class="data-table" id="logTable">
          <thead><tr><th>Hora</th><th>Nível</th><th>Origem</th><th>Código</th><th>ID</th><th>Mensagem</th><th>Detalhe</th></tr></thead>
          <tbody id="logTbody"></tbody>
        </table>
      </div>
    </div>`;

  const allEntries = entries;

  function applyFilters() {
    const level = $("logFilterLevel").value;
    const msg = ($("logFilterMsg").value || "").toLowerCase().trim();
    const fromVal = $("logFilterFrom").value;
    const toVal = $("logFilterTo").value;
    const fromDate = fromVal ? new Date(fromVal + "T00:00:00") : null;
    const toDate = toVal ? new Date(toVal + "T23:59:59.999") : null;

    const filtered = allEntries.filter((x) => {
      if (level && x.level !== level) return false;
      if (msg) {
        const haystack = `${x.message || ""} ${x.detail || ""} ${x.code || ""}`.toLowerCase();
        if (!haystack.includes(msg)) return false;
      }
      if (fromDate || toDate) {
        const ts = x.ts ? new Date(x.ts) : null;
        if (!ts) return false;
        if (fromDate && ts < fromDate) return false;
        if (toDate && ts > toDate) return false;
      }
      return true;
    });

    const tbody = $("logTbody");
    tbody.innerHTML = filtered
      .map(
        (x) => `
      <tr>
        <td><code>${esc(formatTs(x.ts))}</code></td>
        <td>${levelBadge(x.level)}</td>
        <td>${esc(x.source || "")}</td>
        <td><code>${esc(x.code || "")}</code></td>
        <td><code>${esc(x.id || "")}</code></td>
        <td>${esc(x.message || "")}</td>
        <td><code>${esc(x.detail || "")}</code></td>
      </tr>`,
      )
      .join("") || '<tr><td colspan="7" class="sub">Nenhum log corresponde aos filtros.</td></tr>';

    $("logCount").textContent = `${filtered.length} de ${allEntries.length} registros`;
  }

  applyFilters();

  $("logFilterLevel").addEventListener("change", applyFilters);
  $("logFilterMsg").addEventListener("input", applyFilters);
  $("logFilterFrom").addEventListener("change", applyFilters);
  $("logFilterTo").addEventListener("change", applyFilters);

  $("btnClearFilters")?.addEventListener("click", () => {
    $("logFilterLevel").value = "";
    $("logFilterMsg").value = "";
    $("logFilterFrom").value = "";
    $("logFilterTo").value = "";
    applyFilters();
  });

  $("btnReloadLogs")?.addEventListener("click", () => {
    void render();
  });
}

async function renderClientes(view) {
  await loadConfig();
  const endpoint = mcpEndpointUrl();
  const cursorJson = {
    mcpServers: {
      "mcp-hub": {
        url: endpoint,
        headers: {
          "X-MCP-Hub-User-Token": "COLA_AQUI_O_SECRET_DA_API_KEY",
        },
      },
    },
  };
  const claudeJson = {
    mcpServers: {
      "mcp-hub": {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          endpoint,
          "--header",
          "X-MCP-Hub-User-Token:${HUB_USER_TOKEN}",
        ],
        env: {
          HUB_USER_TOKEN: "COLA_AQUI_O_SECRET_DA_API_KEY",
        },
      },
    },
  };
  view.innerHTML = `
    <div class="panel">
      <p class="back-row"><a href="#/inicio">← Início</a></p>
      <h3 class="section-title">Antes de conectar o cliente</h3>
      <ol class="guide-steps">
        <li><strong>No painel:</strong> crie um <a href="#/usuarios">usuário</a>, uma <a href="#/api-keys">API key</a> e os <a href="#/mcps">MCPs</a> vinculados a essa key (catálogo, URL ou template).</li>
        <li><strong>Copie o secret</strong> da API key ao gerá-la — é o valor do header <code>X-MCP-Hub-User-Token</code> (não confundir com a senha do admin do painel).</li>
        <li><strong>URL do hub MCP</strong> neste servidor (origem desta página + caminho configurado):<br /><code class="pre-block" style="margin-top:0.5rem;">${esc(endpoint)}</code>
          <span class="sub">O caminho do endpoint MCP é o configurado neste hub; o endereço acima reflete a sessão atual.</span></li>
      </ol>
    </div>
    <div class="panel">
      <h3 class="section-title">Cursor</h3>
      <ol class="guide-steps">
        <li>Abra <strong>Cursor</strong> → <strong>Settings</strong> → <strong>MCP</strong> (ou edite o arquivo de configuração MCP que o Cursor indicar na sua versão).</li>
        <li>Adicione um servidor <strong>HTTP / Streamable HTTP</strong> apontando para a URL acima.</li>
        <li>Defina o header <code>X-MCP-Hub-User-Token</code> com o <strong>secret</strong> da API key.</li>
        <li>Reinicie o MCP ou o Cursor se o cliente não listar ferramentas imediatamente.</li>
      </ol>
      <p class="section-lead" style="margin-top:1rem;">Exemplo de JSON (ajuste o nome <code>mcp-hub</code> se quiser):</p>
      <pre class="pre-block" id="cursorCfgBlock">${esc(JSON.stringify(cursorJson, null, 2))}</pre>
      <p class="guide-note">Em redes internas, substitua o host pelo IP ou DNS que o Cursor consegue alcançar (o mesmo que você usa para abrir este painel, na porta HTTP do hub).</p>
    </div>
    <div class="panel">
      <h3 class="section-title">Claude Desktop</h3>
      <ol class="guide-steps">
        <li>Feche o Claude Desktop antes de editar o arquivo de configuração.</li>
        <li>No <strong>macOS</strong>, abra <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>. No <strong>Windows</strong>, o caminho geralmente fica em <code>%APPDATA%\\Claude\\claude_desktop_config.json</code> (confirme na documentação Anthropic se mudar).</li>
        <li>Em <code>mcpServers</code>, adicione uma entrada que aponte para o hub. Duas formas comuns:</li>
      </ol>
      <p class="section-lead"><strong>A)</strong> Cliente HTTP nativo (se a sua build suportar URL + headers para MCP remoto):</p>
      <pre class="pre-block">${esc(JSON.stringify(cursorJson, null, 2))}</pre>
      <p class="section-lead" style="margin-top:1rem;"><strong>B)</strong> Via <code>mcp-remote</code> (útil quando o JSON do Claude só expõe <code>command</code>/<code>args</code>):</p>
      <pre class="pre-block">${esc(JSON.stringify(claudeJson, null, 2))}</pre>
      <p class="guide-note">O pacote <code>mcp-remote</code> (npm) faz ponte stdio → HTTP. No Windows, o Claude às vezes quebra headers com espaços nos <code>args</code>; por isso o token vai em <code>env</code> e o <code>--header</code> usa <code>\${HUB_USER_TOKEN}</code> sem espaços ao redor do <code>:</code>. Se a sua versão do Claude aceitar URL + headers diretamente, prefira a opção A.</p>
    </div>`;
}

async function renderUsuarios(view) {
  const { users } = await api("/users");
  view.innerHTML = `
    <div class="panel">
      <h3 class="section-title">Novo usuário</h3>
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
      <h3 class="section-title">Usuários</h3>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Etiqueta</th><th>ID</th><th>Criado</th><th>Ações</th></tr></thead>
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
                    <a class="btn-link secondary" href="#/api-keys?user=${esc(u.id)}">Ver API keys</a>
                    <a class="btn-link secondary" href="#/usuarios/edit/${esc(u.id)}">Editar</a>
                    <button type="button" class="danger btn-del-u" data-id="${esc(u.id)}">Excluir</button>
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

  view.querySelectorAll(".btn-del-u").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!confirm("Excluir este usuário e todos os tokens e MCPs dele?")) return;
      try {
        await api(`/users/${id}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function renderUserEdit(view, userId) {
  const { users } = await api("/users");
  const u = (users || []).find((x) => sameEntityId(x.id, userId));
  if (!u) {
    view.innerHTML = `<p class="feedback feedback--err">Usuário não encontrado.</p><p class="back-row"><a href="#/usuarios">← Usuários</a></p>`;
    return;
  }
  view.innerHTML = `
    <div class="panel">
      <p class="back-row"><a href="#/usuarios">← Usuários</a></p>
      <h3 class="section-title">Editar usuário</h3>
      <p class="sub">ID: <code>${esc(u.id)}</code></p>
      <label for="editULabel">Etiqueta</label>
      <input type="text" id="editULabel" value="${esc(u.label)}" autocomplete="organization" />
      <div class="btn-row">
        <button type="button" id="btnSaveUser">Salvar</button>
        <a href="#/usuarios" class="btn-link secondary">Cancelar</a>
      </div>
      <p id="editUErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>`;
  $("btnSaveUser").onclick = async () => {
    $("editUErr").classList.add("hidden");
    const lab = $("editULabel").value.trim();
    if (!lab) {
      $("editUErr").textContent = "A etiqueta não pode ficar vazia.";
      $("editUErr").classList.remove("hidden");
      return;
    }
    try {
      await api(`/users/${u.id}`, { method: "PUT", body: JSON.stringify({ label: lab }) });
      location.hash = "#/usuarios";
    } catch (e) {
      $("editUErr").textContent = e.message;
      $("editUErr").classList.remove("hidden");
    }
  };
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
        <button type="button" id="btnTplSave">Salvar template</button>
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
        <a class="btn-link secondary" href="#/templates/edit/${esc(d._id)}">Editar</a>
        <button type="button" class="danger btn-tpl-del">Excluir</button>
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
      if (!confirm("Excluir este template?")) return;
      try {
        await api(`/mcp-templates/${id}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    };
  });
}

async function renderTemplateEdit(view, templateId) {
  const { templates } = await api("/mcp-templates");
  const doc = (templates || []).find((x) =>
    sameEntityId(String(x._id ?? ""), String(templateId ?? "")),
  );
  if (!doc) {
    view.innerHTML = `<p class="feedback feedback--err">Template não encontrado.</p><p class="back-row"><a href="#/templates">← Templates</a></p>`;
    return;
  }
  const keysStr = (doc.accessHeaderKeys || []).join(", ");
  view.innerHTML = `
    <div class="panel">
      <p class="back-row"><a href="#/templates">← Templates MCP</a></p>
      <h3 class="section-title">Editar template</h3>
      <div class="row cols-2">
        <div><label for="etplKey">Chave única</label><input type="text" id="etplKey" value="${esc(doc.key)}" /></div>
        <div><label for="etplLabel">Etiqueta</label><input type="text" id="etplLabel" value="${esc(doc.label)}" /></div>
      </div>
      <label for="etplDesc">Descrição (opcional)</label>
      <input type="text" id="etplDesc" value="${esc(doc.description || "")}" />
      <label for="etplHeaderKeys">Cabeçalhos sugeridos (vírgula)</label>
      <input type="text" id="etplHeaderKeys" value="${esc(keysStr)}" />
      <label for="etplDef">Definição MCP base (JSON)</label>
      <textarea id="etplDef" rows="12">${esc(JSON.stringify(doc.def, null, 2))}</textarea>
      <div class="btn-row">
        <button type="button" id="btnTplEditSave">Salvar alterações</button>
        <a href="#/templates" class="btn-link secondary">Cancelar</a>
      </div>
      <p id="etplErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>`;
  $("btnTplEditSave").onclick = async () => {
    $("etplErr").classList.add("hidden");
    let def;
    try {
      def = JSON.parse($("etplDef").value || "{}");
    } catch {
      $("etplErr").textContent = "JSON inválido na definição.";
      $("etplErr").classList.remove("hidden");
      return;
    }
    const keysRaw = $("etplHeaderKeys").value.trim();
    const accessHeaderKeys = keysRaw
      ? keysRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    try {
      await api(`/mcp-templates/${doc._id}`, {
        method: "PUT",
        body: JSON.stringify({
          key: $("etplKey").value.trim(),
          label: $("etplLabel").value.trim(),
          description: $("etplDesc").value.trim() || undefined,
          accessHeaderKeys,
          def,
        }),
      });
      location.hash = "#/templates";
    } catch (e) {
      $("etplErr").textContent = e.message;
      $("etplErr").classList.remove("hidden");
    }
  };
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
      <h3 class="section-title">Novo documento no registro</h3>
      <div class="row cols-2">
        <div><label for="regKey">Chave</label><input type="text" id="regKey" /></div>
        <div><label for="regLabel">Etiqueta</label><input type="text" id="regLabel" /></div>
      </div>
      <label for="regDef">Definição MCP (JSON)</label>
      <textarea id="regDef" rows="10">${esc(defSample)}</textarea>
      <div class="btn-row"><button type="button" id="btnRegSave">Salvar</button></div>
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
        <a class="btn-link secondary" href="#/catalogo/edit/${esc(d._id)}">Editar</a>
        <button type="button" class="danger btn-reg-del">Excluir</button>
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
      if (!confirm("Excluir do registro NoSQL?")) return;
      try {
        await api(`/mcp-registry/${id}`, { method: "DELETE" });
        await render();
      } catch (e) {
        alert(e.message);
      }
    };
  });
}

async function renderCatalogEdit(view, docId) {
  const { documents } = await api("/mcp-registry");
  const doc = (documents || []).find((x) =>
    sameEntityId(String(x._id ?? ""), String(docId ?? "")),
  );
  if (!doc) {
    view.innerHTML = `<p class="feedback feedback--err">Documento não encontrado.</p><p class="back-row"><a href="#/catalogo">← Catálogo</a></p>`;
    return;
  }
  view.innerHTML = `
    <div class="panel">
      <p class="back-row"><a href="#/catalogo">← Catálogo MCP</a></p>
      <h3 class="section-title">Editar documento do registro</h3>
      <p class="sub">_id: <code>${esc(doc._id)}</code></p>
      <div class="row cols-2">
        <div><label for="eregKey">Chave</label><input type="text" id="eregKey" value="${esc(doc.key)}" /></div>
        <div><label for="eregLabel">Etiqueta</label><input type="text" id="eregLabel" value="${esc(doc.label || "")}" /></div>
      </div>
      <label for="eregDef">Definição MCP (JSON)</label>
      <textarea id="eregDef" rows="14">${esc(JSON.stringify(doc.def, null, 2))}</textarea>
      <div class="btn-row">
        <button type="button" id="btnCatalogSave">Salvar alterações</button>
        <a href="#/catalogo" class="btn-link secondary">Cancelar</a>
      </div>
      <p id="eregErr" class="feedback feedback--err hidden" role="alert"></p>
    </div>`;
  $("btnCatalogSave").onclick = async () => {
    $("eregErr").classList.add("hidden");
    let def;
    try {
      def = JSON.parse($("eregDef").value || "{}");
    } catch {
      $("eregErr").textContent = "JSON inválido.";
      $("eregErr").classList.remove("hidden");
      return;
    }
    try {
      await api(`/mcp-registry/${doc._id}`, {
        method: "PUT",
        body: JSON.stringify({
          key: $("eregKey").value.trim(),
          label: $("eregLabel").value.trim(),
          def,
        }),
      });
      location.hash = "#/catalogo";
    } catch (e) {
      $("eregErr").textContent = e.message;
      $("eregErr").classList.remove("hidden");
    }
  };
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

async function renderApiKeys(view, preFilterUserId) {
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
          : `<p class="feedback" role="status">Cria primeiro um usuário em <a href="#/usuarios">Usuários</a>.</p>`
      }
      <div class="row cols-2">
        <div>
          <label for="keyUser">Usuário</label>
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
      <div class="log-filters" style="margin-bottom:0.75rem;">
        <div class="log-filter-group">
          <label for="keyFilterUser">Usuário</label>
          <select id="keyFilterUser">
            <option value="">Todos</option>
            ${(users || []).map((u) => `<option value="${esc(u.id)}"${u.id === preFilterUserId ? " selected" : ""}>${esc(u.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <p class="sub" id="keyCount" style="margin:0 0 0.5rem;"></p>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Usuário</th><th>Etiqueta</th><th>ID do token</th><th>Criado</th><th></th></tr></thead>
          <tbody id="keyTbody"></tbody>
        </table>
      </div>
    </div>`;

  const allRows = rows;

  function renderKeyRows() {
    const filterUid = $("keyFilterUser").value;
    const filtered = filterUid ? allRows.filter((t) => t.userId === filterUid) : allRows;
    const tbody = $("keyTbody");
    tbody.innerHTML = filtered
      .map(
        (t) => `
      <tr>
        <td>${esc(t.userLabel)}</td>
        <td>${esc(t.label)}</td>
        <td><code>${esc(t.id)}</code></td>
        <td>${esc(t.createdAt || "")}</td>
        <td>
          <div class="btn-row" style="margin:0;">
            <button type="button" class="secondary btn-reveal" data-tid="${esc(t.id)}">Ver secret</button>
            <a class="btn-link secondary" href="#/mcps/${esc(t.id)}">MCPs</a>
            <a class="btn-link secondary" href="#/logs?token=${esc(t.id)}">Logs</a>
            <button type="button" class="danger btn-revoke" data-uid="${esc(t.userId)}" data-tid="${esc(t.id)}">Revogar</button>
          </div>
        </td>
      </tr>`,
      )
      .join("") || '<tr><td colspan="5" class="sub">Nenhuma API key para este usuário.</td></tr>';
    $("keyCount").textContent = `${filtered.length} de ${allRows.length} tokens`;
    wireKeyTableButtons();
  }

  function wireKeyTableButtons() {
    view.querySelectorAll(".btn-reveal").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tid = btn.getAttribute("data-tid");
        try {
          const j = await api(`/tokens/${tid}/secret`);
          const row = btn.closest("tr");
          let box = row.querySelector(".reveal-secret-box");
          if (box) {
            box.remove();
            return;
          }
          const td = row.querySelector("td:last-child");
          box = document.createElement("div");
          box.className = "reveal-secret-box";
          box.innerHTML = `<div class="token-box" style="margin-top:0.5rem;font-size:0.75rem;">${esc(j.secret)}</div>`;
          td.appendChild(box);
        } catch (e) {
          alert(e.message);
        }
      });
    });

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

  $("keyFilterUser").addEventListener("change", renderKeyRows);
  renderKeyRows();

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

}

async function renderMcpEdit(view, tokenId, mcpId) {
  const [{ servers }, tplRes, { mcps }] = await Promise.all([
    api("/servers"),
    api("/mcp-templates").catch(() => ({ templates: [] })),
    api(`/tokens/${tokenId}/mcps`),
  ]);
  const tplList = tplRes.templates || [];
  const m = (mcps || []).find((x) => sameEntityId(x.id, mcpId));
  if (!m) {
    view.innerHTML = `<p class="feedback feedback--err">MCP não encontrado.</p><p class="back-row"><a href="#/mcps/${esc(tokenId)}">← MCPs deste token</a></p>`;
    return;
  }
  const mode = m.url ? "direct" : m.templateId ? "admintpl" : "catalog";
  const hdrs = JSON.stringify(m.headers || {}, null, 2);
  const envs = JSON.stringify(m.env || {}, null, 2);
  const conn = JSON.stringify(m.connection || { headers: {}, env: {} }, null, 2);
  const accHdr = JSON.stringify(
    {
      headers: m.connection?.headers ?? {},
      env: m.connection?.env ?? {},
    },
    null,
    2,
  );
  const tplOpts = tplOptsHtml(tplList, m.templateId);
  const srvOpts = serverOptsHtml(servers, m.templateServerKey);

  view.innerHTML = `
    <div class="panel mcp-edit-root">
      <p class="back-row"><a href="#/mcps/${esc(tokenId)}">← MCPs deste token</a></p>
      <h3 class="section-title">Editar MCP</h3>
      <p class="sub">ID: <code>${esc(m.id)}</code></p>
      <div class="row cols-2">
        <div>
          <label class="label-like">Modo</label>
          <select class="mcp-mode">
            <option value="direct"${mode === "direct" ? " selected" : ""}>URL direta</option>
            <option value="catalog"${mode === "catalog" ? " selected" : ""}>Catálogo global</option>
            <option value="admintpl"${mode === "admintpl" ? " selected" : ""}>Template administrativo</option>
          </select>
        </div>
        <div>
          <label class="label-like">Etiqueta (opcional)</label>
          <input type="text" class="mcp-label" value="${esc(m.label || "")}" placeholder="ex. produção" />
        </div>
      </div>
      <div class="mcp-direct-fields">
        <label class="label-like">URL</label>
        <input type="text" class="mcp-url" value="${esc(m.url || "")}" placeholder="https://…/mcp" />
        <label class="label-like" style="margin-top:0.65rem;">Headers (JSON)</label>
        <textarea class="mcp-headers" rows="4">${esc(hdrs)}</textarea>
        <label class="label-like" style="margin-top:0.65rem;">Env (JSON, opcional)</label>
        <textarea class="mcp-env" rows="3">${esc(envs)}</textarea>
      </div>
      <div class="mcp-catalog-fields hidden">
        <label class="label-like">Chave no hub</label>
        <select class="mcp-catalog-key">${srvOpts}</select>
        <label class="label-like" style="margin-top:0.65rem;">Connection (JSON)</label>
        <textarea class="mcp-conn" rows="6">${esc(conn)}</textarea>
      </div>
      <div class="mcp-admintpl-fields hidden">
        <label class="label-like">Template</label>
        <select class="mcp-admin-template-id">${tplOpts}</select>
        <p class="sub mcp-tpl-hint" role="note"></p>
        <label class="label-like" style="margin-top:0.65rem;">Cabeçalhos de acesso (JSON)</label>
        <p class="sub" style="margin:0 0 0.35rem;">Modelo com <code>headers</code> (ex.: e-ship) e opcionalmente <code>env</code>.</p>
        <textarea class="mcp-access-headers" rows="10">${esc(accHdr)}</textarea>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-save-mcp">Salvar alterações</button>
        <a href="#/mcps/${esc(tokenId)}" class="btn-link secondary">Cancelar</a>
      </div>
    </div>`;

  const editRoot = view.querySelector(".mcp-edit-root");
  wireMcpFormPanel(editRoot, tokenId, servers, tplList, { mcpId });
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
        <h3 class="section-title">Selecionar API key</h3>
        <p class="section-lead">Escolha o token para ver e gerir os MCPs vinculados, adicionar novos ou editar os existentes.</p>
        <form id="mcpsPickForm" class="mcps-pick-form">
          <label for="pickTok">Token</label>
          <select id="pickTok" name="token" aria-describedby="pickTokErr">
            <option value="">— Escolhar —</option>
            ${flat
              .map(
                (t) =>
                  `<option value="${esc(t.id)}">${esc(t.userLabel)} · ${esc(t.label)} (${esc(t.id).slice(0, 8)}…)</option>`,
              )
              .join("")}
          </select>
          <p id="pickTokErr" class="feedback feedback--err hidden" role="alert"></p>
          <div class="btn-row">
            <button type="submit" id="btnGoMcps">Abrir</button>
          </div>
        </form>
      </div>`;
    $("mcpsPickForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      tryNavigateMcpsPicker();
    });
    return;
  }

  const tok = flat.find((x) => sameEntityId(x.id, tokenId));
  const { mcps } = await api(`/tokens/${tokenId}/mcps`);

  const mcpRows = (mcps || [])
    .map(
      (m) => `
    <li class="mcp-row" data-mid="${esc(m.id)}">
      <div class="mcp-row__main">
        <strong>${esc(m.label || m.id)}</strong>
        ${
          m.url
            ? `<span class="sub"> · URL direta</span>`
            : m.templateId
              ? (() => {
                  const tt = tplList.find((x) => x._id === m.templateId);
                  return `<span class="sub"> · template: ${esc(tt ? tt.label : m.templateId)}</span>`;
                })()
              : `<span class="sub"> · catálogo: ${esc(m.templateServerKey || "")}</span>`
        }
      </div>
      <div class="mcp-row__actions">
        <a class="btn-link secondary" href="#/mcps/${esc(tokenId)}/edit/${esc(m.id)}">Editar</a>
        <button type="button" class="danger btn-mcp-del" data-mid="${esc(m.id)}">Remover</button>
      </div>
    </li>`,
    )
    .join("");

  view.innerHTML = `
    <div class="panel">
      <p class="section-lead">Token: <strong>${esc(tok ? `${tok.userLabel} · ${tok.label}` : tokenId)}</strong>
        · <a href="#/mcps">Trocar API key</a> · <a href="#/clientes">Como ligar no Cursor / Claude</a></p>
      <h3 class="section-title">MCPs vinculados</h3>
      <ul class="links">${mcpRows || '<li class="sub">Nenhum MCP.</li>'}</ul>
    </div>
    <div class="panel mcp-add-root">
      <h3 class="section-title">Adicionar MCP</h3>
      <div class="row cols-2">
        <div>
          <label class="label-like">Modo</label>
          <select class="mcp-mode">
            <option value="direct">URL direta</option>
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
        <p class="sub" style="margin:0 0 0.35rem;">Modelo com <code>headers</code> (ex.: e-ship) e opcionalmente <code>env</code>.</p>
        <textarea class="mcp-access-headers" rows="10">${esc(MCP_ADMIN_ACCESS_JSON_DEFAULT)}</textarea>
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
}

async function buildBreadcrumb(route) {
  const crumbs = [{ label: "Início", href: "#/inicio" }];

  if (route.name === "inicio") return crumbs;

  if (route.name === "usuarios") {
    crumbs.push({ label: "Usuários" });
    return crumbs;
  }

  if (route.name === "user-edit") {
    crumbs.push({ label: "Usuários", href: "#/usuarios" });
    try {
      const { users } = await api("/users");
      const u = (users || []).find((x) => x.id === route.userId);
      crumbs.push({ label: u ? u.label : route.userId });
    } catch { crumbs.push({ label: route.userId }); }
    return crumbs;
  }

  if (route.name === "api-keys") {
    crumbs.push({ label: "Usuários", href: "#/usuarios" });
    const uid = route.query?.get("user");
    if (uid) {
      try {
        const { users } = await api("/users");
        const u = (users || []).find((x) => x.id === uid);
        crumbs.push({ label: u ? u.label : uid, href: `#/usuarios/edit/${uid}` });
      } catch { crumbs.push({ label: uid }); }
    }
    crumbs.push({ label: "API keys" });
    return crumbs;
  }

  if (route.name === "mcps") {
    crumbs.push({ label: "Usuários", href: "#/usuarios" });
    if (route.tokenId) {
      try {
        const { users } = await api("/users");
        for (const u of users || []) {
          const tok = (u.tokens || []).find((t) => t.id === route.tokenId);
          if (tok) {
            crumbs.push({ label: u.label, href: `#/usuarios/edit/${u.id}` });
            crumbs.push({ label: `API key: ${tok.label}`, href: `#/api-keys?user=${u.id}` });
            break;
          }
        }
      } catch {}
      crumbs.push({ label: "MCPs" });
    } else {
      crumbs.push({ label: "MCPs" });
    }
    return crumbs;
  }

  if (route.name === "mcp-edit") {
    crumbs.push({ label: "Usuários", href: "#/usuarios" });
    if (route.tokenId) {
      try {
        const { users } = await api("/users");
        for (const u of users || []) {
          const tok = (u.tokens || []).find((t) => t.id === route.tokenId);
          if (tok) {
            crumbs.push({ label: u.label, href: `#/usuarios/edit/${u.id}` });
            crumbs.push({ label: `API key: ${tok.label}`, href: `#/api-keys?user=${u.id}` });
            break;
          }
        }
      } catch {}
      crumbs.push({ label: "MCPs", href: `#/mcps/${route.tokenId}` });
    }
    crumbs.push({ label: "Editar MCP" });
    return crumbs;
  }

  if (route.name === "logs") {
    const tokenFilter = route.query?.get("token");
    if (tokenFilter) {
      crumbs.push({ label: "Usuários", href: "#/usuarios" });
      try {
        const { users } = await api("/users");
        for (const u of users || []) {
          const tok = (u.tokens || []).find((t) => t.id === tokenFilter);
          if (tok) {
            crumbs.push({ label: u.label, href: `#/usuarios/edit/${u.id}` });
            crumbs.push({ label: `API key: ${tok.label}`, href: `#/api-keys?user=${u.id}` });
            break;
          }
        }
      } catch {}
    }
    crumbs.push({ label: "Logs do sistema" });
    return crumbs;
  }

  const simpleMap = {
    templates: "Templates MCP",
    catalogo: "Catálogo MCP",
    clientes: "Como conectar?",
  };
  if (simpleMap[route.name]) {
    crumbs.push({ label: simpleMap[route.name] });
    return crumbs;
  }

  if (route.name === "template-edit") {
    crumbs.push({ label: "Templates MCP", href: "#/templates" });
    crumbs.push({ label: "Editar template" });
    return crumbs;
  }

  if (route.name === "catalog-edit") {
    crumbs.push({ label: "Catálogo MCP", href: "#/catalogo" });
    crumbs.push({ label: "Editar catálogo" });
    return crumbs;
  }

  crumbs.push({ label: "Painel" });
  return crumbs;
}

function renderBreadcrumbHtml(crumbs) {
  return crumbs
    .map((c, i) => {
      const isLast = i === crumbs.length - 1;
      const sep = i > 0 ? '<span class="breadcrumb-sep">›</span>' : "";
      if (isLast || !c.href) {
        return `${sep}<span class="breadcrumb-current">${esc(c.label)}</span>`;
      }
      return `${sep}<a class="breadcrumb-link" href="${c.href}">${esc(c.label)}</a>`;
    })
    .join("");
}

async function render() {
  navMark();
  const route = parseRoute();
  const vt = $("viewTitle");
  const view = $("appView");
  if (!view || !vt) return;

  try {
    const crumbs = await buildBreadcrumb(route);
    vt.innerHTML = renderBreadcrumbHtml(crumbs);
  } catch {
    vt.textContent = "Painel";
  }

  try {
    switch (route.name) {
      case "inicio":
        await renderInicio(view);
        break;
      case "clientes":
        await renderClientes(view);
        break;
      case "usuarios":
        await renderUsuarios(view);
        break;
      case "user-edit":
        await renderUserEdit(view, route.userId);
        break;
      case "templates":
        await renderTemplates(view);
        break;
      case "template-edit":
        await renderTemplateEdit(view, route.templateId);
        break;
      case "catalogo":
        await renderCatalogo(view);
        break;
      case "catalog-edit":
        await renderCatalogEdit(view, route.docId);
        break;
      case "api-keys":
        await renderApiKeys(view, route.query?.get("user") || null);
        break;
      case "mcps":
        await renderMcps(view, route.tokenId);
        break;
      case "mcp-edit":
        await renderMcpEdit(view, route.tokenId, route.mcpId);
        break;
      case "logs":
        await renderSystemLogs(view, route.query?.get("token") || null);
        break;
      default:
        if ((location.hash || "").replace(/^#\/?/, "") !== "inicio") {
          location.hash = "#/inicio";
        } else {
          await renderInicio(view);
        }
        break;
    }
  } catch (e) {
    view.innerHTML = `<p class="feedback feedback--err">${esc(e.message)}</p>`;
  }
}

function syncSidebarDisplayName(me) {
  const el = $("sidebarUserName");
  if (!el) return;
  if (me?.admin) {
    el.textContent =
      typeof me.displayName === "string" && me.displayName.trim()
        ? me.displayName.trim()
        : "Admin";
  } else {
    el.textContent = "—";
  }
}

async function checkMe() {
  try {
    const j = await api("/me");
    if (j.admin) {
      showApp();
      syncSidebarDisplayName(j);
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
    const payload = {
      password: $("adminPw").value,
      username: ($("adminUser")?.value ?? "").trim(),
    };
    const loginRes = await api("/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showApp();
    syncSidebarDisplayName({
      admin: true,
      displayName:
        typeof loginRes.displayName === "string" && loginRes.displayName.trim()
          ? loginRes.displayName
          : "Admin",
    });
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
  syncSidebarDisplayName({ admin: false });
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

async function applyLoginUiMode() {
  const lead = $("loginLead");
  const wrap = $("loginUserWrap");
  const userIn = $("adminUser");
  try {
    const j = await api("/auth-config");
    if (j.configured && j.loginMode === "ldap") {
      wrap?.classList.remove("hidden");
      userIn?.setAttribute("required", "required");
      if (lead) {
        lead.textContent = "Digite as credenciais de acesso ao painel.";
      }
    } else {
      wrap?.classList.add("hidden");
      userIn?.removeAttribute("required");
      if (lead) {
        lead.textContent =
          "Digite a senha de administrador definida na configuração do hub.";
      }
    }
  } catch {
    wrap?.classList.add("hidden");
    userIn?.removeAttribute("required");
    if (lead) {
      lead.textContent = "Digite as credenciais de acesso ao painel.";
    }
  }
}

void applyLoginUiMode();
void checkMe();

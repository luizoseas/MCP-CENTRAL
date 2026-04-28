/** Painel MCP Hub — SPA com hash routes (#/inicio, …). */
const $ = (id) => document.getElementById(id);

/** Secret mostrado uma vez após criar token (evita perder o banner com re-render). */
let pendingNewKeySecret = null;

/** Última resposta de GET /api/config (caminho MCP, ficheiros, …). */
let hubConfig = {
  usersFile: "",
  mcpRegistryFile: "",
  mcpHttpPath: "/mcp",
};

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
  if (!r.ok) throw new Error(j.error || r.statusText);
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
      errEl.textContent = "Escolhe uma API key na lista.";
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
  const parts = h.split("/").filter(Boolean);
  const name = parts[0] || "inicio";
  const empty = { tokenId: null, mcpId: null, userId: null, templateId: null, docId: null };
  const seg = (i) => (typeof parts[i] === "string" ? parts[i].trim() : "");

  if (name === "mcps" && seg(1)) {
    if (seg(2) === "edit" && seg(3)) {
      return { name: "mcp-edit", tokenId: seg(1), mcpId: seg(3), ...empty };
    }
    return { name: "mcps", tokenId: seg(1), ...empty };
  }
  if (name === "utilizadores" && seg(1) === "edit" && seg(2)) {
    return { name: "user-edit", userId: seg(2), ...empty };
  }
  if (name === "templates" && seg(1) === "edit" && seg(2)) {
    return { name: "template-edit", templateId: seg(2), ...empty };
  }
  if (name === "catalogo" && seg(1) === "edit" && seg(2)) {
    return { name: "catalog-edit", docId: seg(2), ...empty };
  }

  return { name, ...empty };
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
    hubConfig.usersFile = j.usersFile || "";
    hubConfig.mcpRegistryFile = j.mcpRegistryFile || "";
    hubConfig.mcpHttpPath = typeof j.mcpHttpPath === "string" && j.mcpHttpPath ? j.mcpHttpPath : "/mcp";
    $("dataPath").textContent = hubConfig.usersFile;
    $("registryPath").textContent = hubConfig.mcpRegistryFile;
  } catch {
    $("dataPath").textContent = "?";
    $("registryPath").textContent = "?";
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
      <p class="section-lead">Escolhe uma secção na barra lateral. Os ficheiros de dados aparecem acima.</p>
      <div class="quick-grid cols-2">
        <a class="card-link" href="#/clientes"><strong>Ligar Cursor / Claude</strong>Passo a passo com URL do hub e cabeçalho do token.</a>
        <a class="card-link" href="#/utilizadores"><strong>Utilizadores</strong>Criar, editar etiqueta e apagar contas.</a>
        <a class="card-link" href="#/templates"><strong>Templates MCP</strong>Definições base e variáveis sugeridas.</a>
        <a class="card-link" href="#/catalogo"><strong>Catálogo MCP</strong>Entradas <code>mcp_servers</code> no registo JSON.</a>
        <a class="card-link" href="#/api-keys"><strong>API keys</strong>Criar e revogar tokens por utilizador.</a>
        <a class="card-link" href="#/mcps"><strong>MCPs por API key</strong>Ligar MCPs a um token e editar variáveis.</a>
      </div>
    </div>`;
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
      <h3 class="section-title">Antes de ligar o cliente</h3>
      <ol class="guide-steps">
        <li><strong>No painel:</strong> cria um <a href="#/utilizadores">utilizador</a>, uma <a href="#/api-keys">API key</a> e os <a href="#/mcps">MCPs</a> vinculados a essa key (catálogo, URL ou template).</li>
        <li><strong>Copia o secret</strong> da API key quando a gerares — é o valor do cabeçalho <code>X-MCP-Hub-User-Token</code> (não confundir com a palavra-passe do admin do painel).</li>
        <li><strong>URL do hub MCP</strong> neste servidor (origem desta página + caminho configurado):<br /><code class="pre-block" style="margin-top:0.5rem;">${esc(endpoint)}</code>
          <span class="sub">O caminho do endpoint MCP é o configurado neste hub; o endereço acima reflecte a sessão actual.</span></li>
      </ol>
    </div>
    <div class="panel">
      <h3 class="section-title">Cursor</h3>
      <ol class="guide-steps">
        <li>Abre <strong>Cursor</strong> → <strong>Settings</strong> → <strong>MCP</strong> (ou edita o ficheiro de configuração MCP que o Cursor indicar na tua versão).</li>
        <li>Adiciona um servidor <strong>HTTP / Streamable HTTP</strong> apontando para a URL acima.</li>
        <li>Define o cabeçalho <code>X-MCP-Hub-User-Token</code> com o <strong>secret</strong> da API key.</li>
        <li>Reinicia o MCP ou o Cursor se o cliente não listar ferramentas de imediato.</li>
      </ol>
      <p class="section-lead" style="margin-top:1rem;">Exemplo de JSON (ajusta o nome <code>mcp-hub</code> se quiseres):</p>
      <pre class="pre-block" id="cursorCfgBlock">${esc(JSON.stringify(cursorJson, null, 2))}</pre>
      <p class="guide-note">Em redes internas, substitui o host por o IP ou DNS que o Cursor consegue alcançar (o mesmo que usas para abrir este painel, na porta HTTP do hub).</p>
    </div>
    <div class="panel">
      <h3 class="section-title">Claude Desktop</h3>
      <ol class="guide-steps">
        <li>Fecha o Claude Desktop antes de editar o ficheiro de configuração.</li>
        <li>No <strong>macOS</strong>, abre <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>. No <strong>Windows</strong>, o caminho costuma estar em <code>%APPDATA%\\Claude\\claude_desktop_config.json</code> (confirma na documentação Anthropic se mudar).</li>
        <li>Em <code>mcpServers</code>, adiciona uma entrada que aponte para o hub. Duas formas comuns:</li>
      </ol>
      <p class="section-lead"><strong>A)</strong> Cliente HTTP nativo (se a tua build suportar URL + headers para MCP remoto):</p>
      <pre class="pre-block">${esc(JSON.stringify(cursorJson, null, 2))}</pre>
      <p class="section-lead" style="margin-top:1rem;"><strong>B)</strong> Via <code>mcp-remote</code> (útil quando o JSON do Claude só expõe <code>command</code>/<code>args</code>):</p>
      <pre class="pre-block">${esc(JSON.stringify(claudeJson, null, 2))}</pre>
      <p class="guide-note">O pacote <code>mcp-remote</code> (npm) faz de ponte stdio → HTTP. No Windows, o Claude por vezes partim cabeçalhos com espaços nos <code>args</code>; por isso o token vai em <code>env</code> e o <code>--header</code> usa <code>\${HUB_USER_TOKEN}</code> sem espaços à volta do <code>:</code>. Se a tua versão do Claude aceitar URL + headers directamente, prefere a opção A.</p>
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
                    <a class="btn-link secondary" href="#/utilizadores/edit/${esc(u.id)}">Editar</a>
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

async function renderUserEdit(view, userId) {
  const { users } = await api("/users");
  const u = (users || []).find((x) => sameEntityId(x.id, userId));
  if (!u) {
    view.innerHTML = `<p class="feedback feedback--err">Utilizador não encontrado.</p><p class="back-row"><a href="#/utilizadores">← Utilizadores</a></p>`;
    return;
  }
  view.innerHTML = `
    <div class="panel">
      <p class="back-row"><a href="#/utilizadores">← Utilizadores</a></p>
      <h3 class="section-title">Editar utilizador</h3>
      <p class="sub">ID: <code>${esc(u.id)}</code></p>
      <label for="editULabel">Etiqueta</label>
      <input type="text" id="editULabel" value="${esc(u.label)}" autocomplete="organization" />
      <div class="btn-row">
        <button type="button" id="btnSaveUser">Guardar</button>
        <a href="#/utilizadores" class="secondary" style="margin-top:0.75rem;display:inline-flex;align-items:center;padding:0.55rem 1.1rem;text-decoration:none;border-radius:6px;border:1px solid var(--border-strong);">Cancelar</a>
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
      location.hash = "#/utilizadores";
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
        <a class="btn-link secondary" href="#/templates/edit/${esc(d._id)}">Editar</a>
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
}

async function renderTemplateEdit(view, templateId) {
  const { templates } = await api("/mcp-templates");
  const doc = (templates || []).find((x) => x._id === templateId);
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
        <button type="button" id="btnTplEditSave">Guardar alterações</button>
        <a href="#/templates" class="secondary" style="margin-top:0.75rem;display:inline-flex;align-items:center;padding:0.55rem 1.1rem;text-decoration:none;border-radius:6px;border:1px solid var(--border-strong);">Cancelar</a>
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
      await api(`/mcp-templates/${templateId}`, {
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
        <a class="btn-link secondary" href="#/catalogo/edit/${esc(d._id)}">Editar</a>
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
}

async function renderCatalogEdit(view, docId) {
  const { documents } = await api("/mcp-registry");
  const doc = (documents || []).find((x) => x._id === docId);
  if (!doc) {
    view.innerHTML = `<p class="feedback feedback--err">Documento não encontrado.</p><p class="back-row"><a href="#/catalogo">← Catálogo</a></p>`;
    return;
  }
  view.innerHTML = `
    <div class="panel">
      <p class="back-row"><a href="#/catalogo">← Catálogo MCP</a></p>
      <h3 class="section-title">Editar documento do registo</h3>
      <p class="sub">_id: <code>${esc(doc._id)}</code></p>
      <div class="row cols-2">
        <div><label for="eregKey">Chave</label><input type="text" id="eregKey" value="${esc(doc.key)}" /></div>
        <div><label for="eregLabel">Etiqueta</label><input type="text" id="eregLabel" value="${esc(doc.label || "")}" /></div>
      </div>
      <label for="eregDef">Definição MCP (JSON)</label>
      <textarea id="eregDef" rows="14">${esc(JSON.stringify(doc.def, null, 2))}</textarea>
      <div class="btn-row">
        <button type="button" id="btnCatalogSave">Guardar alterações</button>
        <a href="#/catalogo" class="secondary" style="margin-top:0.75rem;display:inline-flex;align-items:center;padding:0.55rem 1.1rem;text-decoration:none;border-radius:6px;border:1px solid var(--border-strong);">Cancelar</a>
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
      await api(`/mcp-registry/${docId}`, {
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
  const accHdr = JSON.stringify(m.connection?.headers || {}, null, 2);
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
            <option value="direct"${mode === "direct" ? " selected" : ""}>URL directa</option>
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
        <textarea class="mcp-access-headers" rows="5">${esc(accHdr)}</textarea>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-save-mcp">Guardar alterações</button>
        <a href="#/mcps/${esc(tokenId)}" class="secondary" style="margin-top:0.75rem;display:inline-flex;align-items:center;padding:0.55rem 1.1rem;text-decoration:none;border-radius:6px;border:1px solid var(--border-strong);">Cancelar</a>
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
        <h3 class="section-title">Seleccionar API key</h3>
        <p class="section-lead">Escolhe o token para gerir os MCPs vinculados (URL, catálogo ou template admin + variáveis).</p>
        <label for="pickTok">Token</label>
        <select id="pickTok" aria-describedby="pickTokErr">
          <option value="">— Escolher —</option>
          ${flat
            .map(
              (t) =>
                `<option value="${esc(t.id)}">${esc(t.userLabel)} · ${esc(t.label)} (${esc(t.id).slice(0, 8)}…)</option>`,
            )
            .join("")}
        </select>
        <p id="pickTokErr" class="feedback feedback--err hidden" role="alert"></p>
        <div class="btn-row">
          <button type="button" id="btnGoMcps">Abrir</button>
        </div>
      </div>`;
    $("pickTok")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        tryNavigateMcpsPicker();
      }
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
}

function viewTitleForRoute(route) {
  const map = {
    inicio: "Início",
    utilizadores: "Utilizadores",
    templates: "Templates MCP",
    catalogo: "Catálogo MCP",
    "api-keys": "API keys",
    mcps: "MCPs por API key",
    clientes: "Ligar Cursor / Claude",
    "user-edit": "Editar utilizador",
    "template-edit": "Editar template",
    "catalog-edit": "Editar catálogo",
    "mcp-edit": "Editar MCP",
  };
  return map[route.name] || "Painel";
}

async function render() {
  navMark();
  const route = parseRoute();
  const vt = $("viewTitle");
  const view = $("appView");
  if (!view || !vt) return;

  vt.textContent = viewTitleForRoute(route);

  try {
    switch (route.name) {
      case "inicio":
        await renderInicio(view);
        break;
      case "clientes":
        await renderClientes(view);
        break;
      case "utilizadores":
        await renderUtilizadores(view);
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
        await renderApiKeys(view);
        break;
      case "mcps":
        await renderMcps(view, route.tokenId);
        break;
      case "mcp-edit":
        await renderMcpEdit(view, route.tokenId, route.mcpId);
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

$("appView")?.addEventListener("click", (ev) => {
  if (!ev.target.closest("#btnGoMcps")) return;
  tryNavigateMcpsPicker();
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
        lead.textContent =
          "Utilizador e palavra-passe do domínio (LDAP). O utilizador tem de existir na base configurada no hub.";
      }
    } else {
      wrap?.classList.add("hidden");
      userIn?.removeAttribute("required");
      if (lead) {
        lead.textContent =
          "Introduz a palavra-passe de administrador definida na configuração do hub.";
      }
    }
  } catch {
    wrap?.classList.add("hidden");
    userIn?.removeAttribute("required");
    if (lead) {
      lead.textContent = "Introduz as credenciais de acesso ao painel.";
    }
  }
}

void applyLoginUiMode();
void checkMe();

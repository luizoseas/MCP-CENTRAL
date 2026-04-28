import { Client, InvalidCredentialsError } from "ldapts";

/** Ligação com conta de serviço + pesquisa + bind do utilizador. */
export type HubLdapServiceOptions = {
  authMode: "service";
  url: string;
  bindDn: string;
  bindPassword: string;
  userSearchBase: string;
  /** Deve conter exactamente `{{username}}` (valor escapado RFC4515). */
  userFilter: string;
  searchScope: "base" | "one" | "sub" | "children" | "subordinates";
  connectTimeoutMs: number;
  /** Para ldaps com certificado não confiável (só se inevitável). */
  tlsRejectUnauthorized: boolean;
};

/**
 * Só URL + base no ambiente; utilizador e palavra-passe vêm do cliente.
 * Identidade de bind = substituir `{{username}}` no modelo, excepto se o
 * cliente enviar já UPN (`@`) ou DN (`dn=` / `cn=`, etc.).
 */
export type HubLdapDirectOptions = {
  authMode: "direct";
  url: string;
  /** Deve conter `{{username}}` (excepto quando o login já é UPN/DN completo). */
  userBindIdentityTemplate: string;
  connectTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
};

export type HubLdapOptions = HubLdapServiceOptions | HubLdapDirectOptions;

export type LdapVerifyResult =
  | { ok: true }
  | { ok: false; error: string; statusCode?: number };

/** Opções comuns à ligação TCP/TLS. */
export type HubLdapConnectionFields = {
  url: string;
  connectTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
};

/** Extrai domínio estilo DNS a partir de componentes `DC=` do DN (esq.→dir.: eship.local). */
export function upnDomainFromBaseDn(baseDn: string): string | null {
  const parts = baseDn.split(",").map((p) => p.trim());
  const dcs: string[] = [];
  for (const p of parts) {
    const m = /^dc=(.+)$/i.exec(p);
    if (m) dcs.push(m[1]!);
  }
  if (dcs.length === 0) {
    return null;
  }
  return dcs.join(".");
}

/** Escapa um valor para uso dentro de um filtro LDAP (RFC4515). */
export function escapeLdapFilterValue(value: string): string {
  return value
    .replace(/\\/g, "\\5c")
    .replace(/\0/g, "\\00")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\*/g, "\\2a");
}

function clientOptions(opts: HubLdapConnectionFields) {
  const o: ConstructorParameters<typeof Client>[0] = {
    url: opts.url,
    connectTimeout: opts.connectTimeoutMs,
    timeout: opts.connectTimeoutMs,
    strictDN: false,
  };
  if (opts.url.startsWith("ldaps:")) {
    o.tlsOptions = {
      rejectUnauthorized: !opts.tlsRejectUnauthorized,
    };
  }
  return o;
}

async function safeUnbind(c: Client): Promise<void> {
  try {
    await c.unbind();
  } catch {
    /* ignorar */
  }
}

function isLdapResultCodeError(
  err: unknown,
): err is Error & { code: number; name: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "number" &&
    err instanceof Error
  );
}

function isServiceBindPhase(phase: string): boolean {
  return phase === "serviceBind" || phase === "bindServico";
}

function describeLdapOrNetworkError(err: unknown, phase: string): string {
  if (err instanceof InvalidCredentialsError) {
    if (phase === "userBind" || phase === "directBind") {
      return "LDAP: palavra-passe incorrecta para este utilizador (credenciais inválidas no servidor).";
    }
    if (isServiceBindPhase(phase)) {
      return [
        "LDAP (conta de serviço no .env): credenciais inválidas para MCP_HUB_LDAP_BIND_DN / MCP_HUB_LDAP_BIND_PASSWORD.",
        "Isto ocorre antes do login do painel — não são o utilizador nem a palavra-passe que escreves no formulário.",
        "No Active Directory, data 52e costuma indicar palavra-passe errada ou conta de serviço restrita.",
        "Se queres validar só com utilizador e palavra-passe do domínio (ex.: login@eship.local), remove do ambiente MCP_HUB_LDAP_BIND_DN, MCP_HUB_LDAP_BIND_PASSWORD e MCP_HUB_LDAP_USER_SEARCH_BASE e define MCP_HUB_LDAP_URL + MCP_HUB_LDAP_BASE_DN (modo LDAP directo).",
      ].join(" ");
    }
    return `LDAP (${phase}): credenciais inválidas — ${err.message || "sem detalhe"}`;
  }
  if (isLdapResultCodeError(err)) {
    const msg = err.message || "(sem mensagem)";
    if (isServiceBindPhase(phase)) {
      return [
        `LDAP (conta de serviço no .env): código ${err.code} — ${msg}`,
        "Este passo usa MCP_HUB_LDAP_BIND_DN e MCP_HUB_LDAP_BIND_PASSWORD, não o utilizador do formulário.",
        "Para login directo ao AD sem conta de serviço, remove BIND_DN, BIND_PASSWORD e USER_SEARCH_BASE e usa MCP_HUB_LDAP_BASE_DN (ver documentação modo B1).",
      ].join(" ");
    }
    return `LDAP (${phase}): código ${err.code} — ${msg}`;
  }
  if (err instanceof Error) {
    const node = err as NodeJS.ErrnoException;
    if (node.code === "ECONNREFUSED") {
      return "Não foi possível ligar ao servidor LDAP (ligação recusada). Verifica MCP_HUB_LDAP_URL, porta, firewall e se o serviço está activo.";
    }
    if (node.code === "ETIMEDOUT" || node.code === "ESOCKETTIMEDOUT") {
      return "Tempo esgotado ao contactar o servidor LDAP. Verifica rede, firewall e MCP_HUB_LDAP_TIMEOUT_MS.";
    }
    if (node.code === "ENOTFOUND" || node.code === "EAI_AGAIN") {
      return `Erro de rede/DNS ao servidor LDAP: ${err.message}`;
    }
    if (node.code === "CERT_HAS_EXPIRED" || node.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      return `TLS/LDAPS: ${err.message}. Em laboratório podes definir MCP_HUB_LDAP_TLS_INSECURE=1 (não recomendado em produção).`;
    }
    return `Erro de comunicação (${phase}): ${err.message}`;
  }
  return `Erro desconhecido (${phase}).`;
}

/** Resolve identidade para simple bind (UPN, DN ou modelo com {{username}}). */
export function resolveDirectBindIdentity(
  template: string,
  username: string,
): string {
  const user = username.trim();
  if (!user) {
    return "";
  }
  const looksLikeFullPrincipal =
    user.includes("@") ||
    /^([a-z]+)=/i.test(user) ||
    user.includes("\\"); /* DOMAIN\user */
  if (looksLikeFullPrincipal) {
    return user;
  }
  return template.replace(/\{\{username\}\}/g, user);
}

/**
 * Valida utilizador + palavra-passe contra LDAP.
 * - `direct`: um único bind com credenciais do cliente.
 * - `service`: bind de serviço, pesquisa, bind do utilizador.
 * O utilizador reservado «admin» é tratado no router (palavra-passe local).
 */
export async function verifyLdapUserPassword(
  opts: HubLdapOptions,
  username: string,
  password: string,
): Promise<LdapVerifyResult> {
  const user = username.trim();
  const pw = password;
  if (!user || !pw) {
    return { ok: false, error: "Utilizador e palavra-passe são obrigatórios." };
  }

  if (opts.authMode === "direct") {
    if (!opts.userBindIdentityTemplate.includes("{{username}}")) {
      return {
        ok: false,
        error:
          "Configuração LDAP: o modelo de identidade (MCP_HUB_LDAP_USER_DN_TEMPLATE) tem de incluir {{username}}.",
        statusCode: 500,
      };
    }
    const identity = resolveDirectBindIdentity(
      opts.userBindIdentityTemplate,
      user,
    );
    if (!identity) {
      return { ok: false, error: "Indica o utilizador." };
    }
    const client = new Client(clientOptions(opts));
    try {
      await client.bind(identity, pw);
      await safeUnbind(client);
      return { ok: true };
    } catch (err) {
      await safeUnbind(client);
      if (err instanceof InvalidCredentialsError || isLdapResultCodeError(err)) {
        return {
          ok: false,
          error: describeLdapOrNetworkError(err, "directBind"),
          statusCode: 401,
        };
      }
      return {
        ok: false,
        error: describeLdapOrNetworkError(err, "directBind"),
        statusCode: 503,
      };
    }
  }

  if (!opts.userFilter.includes("{{username}}")) {
    return {
      ok: false,
      error:
        "Configuração LDAP: MCP_HUB_LDAP_USER_FILTER tem de incluir o marcador {{username}}.",
      statusCode: 500,
    };
  }
  const filter = opts.userFilter.replace(
    /\{\{username\}\}/g,
    escapeLdapFilterValue(user),
  );

  const service = new Client(clientOptions(opts));
  let userDn: string | undefined;
  try {
    await service.bind(opts.bindDn, opts.bindPassword);
  } catch (err) {
    await safeUnbind(service);
    return {
      ok: false,
      error: describeLdapOrNetworkError(err, "serviceBind"),
      statusCode: 503,
    };
  }

  try {
    const { searchEntries } = await service.search(opts.userSearchBase, {
      scope: opts.searchScope,
      filter,
      sizeLimit: 5,
      attributes: ["dn"],
    });
    await safeUnbind(service);
    if (searchEntries.length === 0) {
      return {
        ok: false,
        error:
          "LDAP: não foi encontrado nenhum utilizador com esse nome na base configurada (MCP_HUB_LDAP_USER_SEARCH_BASE / MCP_HUB_LDAP_USER_FILTER).",
        statusCode: 401,
      };
    }
    if (searchEntries.length > 1) {
      return {
        ok: false,
        error:
          "LDAP: o filtro devolveu várias entradas (ambiguidade). Ajusta MCP_HUB_LDAP_USER_FILTER ou a base de pesquisa.",
        statusCode: 500,
      };
    }
    userDn = searchEntries[0]!.dn;
  } catch (err) {
    await safeUnbind(service);
    return {
      ok: false,
      error: describeLdapOrNetworkError(err, "pesquisa"),
      statusCode: 503,
    };
  }

  const userClient = new Client(clientOptions(opts));
  try {
    await userClient.bind(userDn!, pw);
    await safeUnbind(userClient);
    return { ok: true };
  } catch (err) {
    await safeUnbind(userClient);
    if (err instanceof InvalidCredentialsError || isLdapResultCodeError(err)) {
      return {
        ok: false,
        error: describeLdapOrNetworkError(err, "userBind"),
        statusCode: 401,
      };
    }
    return {
      ok: false,
      error: describeLdapOrNetworkError(err, "autenticacaoUtilizador"),
      statusCode: 503,
    };
  }
}

import { Client, InvalidCredentialsError } from "ldapts";

/** Opções de ligação e pesquisa LDAP para autenticação no painel admin. */
export type HubLdapOptions = {
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

export type LdapVerifyResult =
  | { ok: true }
  | { ok: false; error: string; statusCode?: number };

/** Escapa um valor para uso dentro de um filtro LDAP (RFC4515). */
export function escapeLdapFilterValue(value: string): string {
  return value
    .replace(/\\/g, "\\5c")
    .replace(/\0/g, "\\00")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\*/g, "\\2a");
}

function clientOptions(opts: HubLdapOptions) {
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

function describeLdapOrNetworkError(err: unknown, phase: string): string {
  if (err instanceof InvalidCredentialsError) {
    if (phase === "userBind") {
      return "LDAP: palavra-passe incorrecta para este utilizador (credenciais inválidas no servidor).";
    }
    if (phase === "serviceBind") {
      return "LDAP: bind da conta de serviço falhou (credenciais inválidas). Verifica MCP_HUB_LDAP_BIND_DN e MCP_HUB_LDAP_BIND_PASSWORD.";
    }
    return `LDAP (${phase}): credenciais inválidas — ${err.message || "sem detalhe"}`;
  }
  if (isLdapResultCodeError(err)) {
    const msg = err.message || "(sem mensagem)";
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

/**
 * Valida utilizador + palavra-passe: bind de serviço, pesquisa uma entrada,
 * bind com DN encontrado e palavra-passe do utilizador.
 * Não usar para o utilizador reservado «admin» (tratado no router com palavra-passe local).
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
      error: describeLdapOrNetworkError(err, "bindServico"),
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

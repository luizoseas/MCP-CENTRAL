import { Client } from "ldapts";

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

/**
 * Valida utilizador + palavra-passe: bind de serviço, pesquisa uma entrada,
 * bind com DN encontrado e palavra-passe do utilizador.
 */
export async function verifyLdapUserPassword(
  opts: HubLdapOptions,
  username: string,
  password: string,
): Promise<boolean> {
  const user = username.trim();
  const pw = password;
  if (!user || !pw) {
    return false;
  }
  if (!opts.userFilter.includes("{{username}}")) {
    throw new Error(
      "MCP_HUB_LDAP_USER_FILTER tem de incluir o marcador {{username}}.",
    );
  }
  const filter = opts.userFilter.replace(
    /\{\{username\}\}/g,
    escapeLdapFilterValue(user),
  );

  const service = new Client(clientOptions(opts));
  let userDn: string | undefined;
  try {
    await service.bind(opts.bindDn, opts.bindPassword);
    const { searchEntries } = await service.search(opts.userSearchBase, {
      scope: opts.searchScope,
      filter,
      sizeLimit: 5,
      attributes: ["dn"],
    });
    if (searchEntries.length !== 1) {
      await safeUnbind(service);
      return false;
    }
    userDn = searchEntries[0]!.dn;
    await safeUnbind(service);
  } catch {
    await safeUnbind(service);
    return false;
  }

  const userClient = new Client(clientOptions(opts));
  try {
    await userClient.bind(userDn!, pw);
    await safeUnbind(userClient);
    return true;
  } catch {
    await safeUnbind(userClient);
    return false;
  }
}

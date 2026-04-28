import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function wrapFsWriteError(filePath: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  const code = e.code;
  const base = e instanceof Error ? e.message : String(err);
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `${base} (caminho: ${filePath}). Em Docker: a pasta tem de ser gravável pelo utilizador do processo (imagem usa USER node, tipicamente UID 1000); monte o volume com permissões correctas, ou use MCP_HUB_MONGODB_URI para MongoDB.`,
    );
  }
  if (code === "EROFS") {
    return new Error(
      `${base} (caminho: ${filePath}). Sistema de ficheiros só de leitura; defina outro MCP_HUB_USERS_FILE ou MCP_HUB_MONGODB_URI.`,
    );
  }
  return e instanceof Error ? e : new Error(base);
}

/**
 * Grava JSON no caminho final **sem ficheiros temporários** (um único `writeFile`).
 * Menos atómico que rename+tmp, mas evita EACCES em volumes Docker e não usa `.tmp`.
 */
export async function writeJsonToFile(filePath: string, data: unknown): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const json = `${JSON.stringify(data, null, 2)}\n`;
    await writeFile(filePath, json, "utf8");
  } catch (err) {
    throw wrapFsWriteError(filePath, err);
  }
}

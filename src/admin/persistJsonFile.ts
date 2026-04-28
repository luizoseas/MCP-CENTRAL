import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Grava JSON com ficheiro temporário + `rename` para o destino quando o SO permite.
 *
 * O `.tmp` **não** fica na mesma pasta que o JSON final: em Docker, volumes em `/app/data`
 * costumam não permitir criar ficheiros novos (EACCES) apesar de substituir o `.json`.
 * Usa-se `os.tmpdir()` (normalmente gravável pelo utilizador do processo).
 *
 * Entre filesystems, `rename` devolve EXDEV — nesse caso grava-se directamente no destino.
 * No Windows, `rename` sobre o destino existente pode falhar com EPERM/EACCES/EBUSY;
 * faz-se retry com backoff e, em último caso, `writeFile` directo no destino.
 */
export async function persistJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = join(tmpdir(), `mcp-hub-persist-${randomBytes(12).toString("hex")}.tmp`);
  await writeFile(tmp, json, "utf8");
  let renameErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (e: unknown) {
      renameErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        break;
      }
      if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
        await sleep(40 + attempt * 35);
        continue;
      }
      break;
    }
  }
  try {
    await writeFile(filePath, json, "utf8");
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw renameErr ?? e;
  }
  await unlink(tmp).catch(() => undefined);
}

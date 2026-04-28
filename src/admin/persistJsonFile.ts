import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Grava JSON com ficheiro temporário + rename atómico quando o SO permite.
 * No Windows, `rename` para um ficheiro existente falha frequentemente com EPERM/EACCES/EBUSY
 * (antivírus, lock); faz-se retry com backoff e, em último caso, `writeFile` directo no destino.
 */
export async function persistJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmp, json, "utf8");
  let renameErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (e: unknown) {
      renameErr = e;
      const code = (e as NodeJS.ErrnoException).code;
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

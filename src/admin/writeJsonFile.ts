import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Grava JSON no caminho final **sem ficheiros temporários** (um único `writeFile`).
 * Menos atómico que rename+tmp, mas evita EACCES em volumes Docker e não usa `.tmp`.
 */
export async function writeJsonToFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, json, "utf8");
}

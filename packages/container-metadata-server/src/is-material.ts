import { readFile } from "node:fs/promises";

export const IS_MATERIAL_PATH = "/run/crc-is-material";

export function parseIsMaterial(raw: string): boolean {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${IS_MATERIAL_PATH} must hold 'true' or 'false', but holds ${JSON.stringify(value)}`);
}

export async function readIsMaterialChange(path = IS_MATERIAL_PATH): Promise<boolean | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseIsMaterial(raw);
}

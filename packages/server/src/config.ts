import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentsFile } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let configCache: EnvironmentsFile | null = null;

export async function loadConfigurations(): Promise<EnvironmentsFile> {
  if (configCache) return configCache;
  const configPath = resolve(__dirname, "../../../configs/environments.json");
  const raw = await readFile(configPath, "utf-8");
  configCache = JSON.parse(raw) as EnvironmentsFile;
  return configCache;
}

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const CRC_ENV_IMAGE = process.env.CRC_ENV_IMAGE || "crc-env:latest";

export function validateEnvironment(): void {
  const missing: string[] = [];
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    console.warn(`Warning: missing environment variables: ${missing.join(", ")}`);
  }
}

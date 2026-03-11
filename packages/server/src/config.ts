import { readFile } from "node:fs/promises";
import { environmentsFileSchema, type EnvironmentsFile } from "./types.js";

let configCache: EnvironmentsFile | null = null;

export async function loadConfigurations(): Promise<EnvironmentsFile> {
  if (configCache) return configCache;
  const raw = await readFile("/configs/environments.json", "utf-8");
  const parsed: unknown = JSON.parse(raw);
  configCache = environmentsFileSchema.parse(parsed);
  return configCache;
}

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const GITLAB_TOKEN = process.env.GITLAB_TOKEN || "";
export const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";
export const CRC_ENV_IMAGE = "ghcr.io/joeoc2001/code-remote-control-env:latest";

export function validateEnvironment(): void {
  const missing: string[] = [];
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

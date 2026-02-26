import { readFile } from "node:fs/promises";
import type { EnvironmentsFile, EnvironmentConfig } from "./types.js";

let configCache: EnvironmentsFile | null = null;

function validateConfigShape(data: unknown): asserts data is EnvironmentsFile {
  if (typeof data !== "object" || data === null || !("configurations" in data)) {
    throw new Error("Config file must contain a 'configurations' array");
  }
  const { configurations } = data as { configurations: unknown };
  if (!Array.isArray(configurations)) {
    throw new Error("'configurations' must be an array");
  }
  for (const entry of configurations) {
    const config = entry as Partial<EnvironmentConfig>;
    if (typeof config.name !== "string" || !config.name) {
      throw new Error("Each configuration must have a non-empty 'name' string");
    }
    if (typeof config.description !== "string") {
      throw new Error(`Configuration '${config.name}' must have a 'description' string`);
    }
    if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) {
      throw new Error(`Configuration '${config.name}' must have an 'env' object`);
    }
  }
}

export async function loadConfigurations(): Promise<EnvironmentsFile> {
  if (configCache) return configCache;
  const raw = await readFile("/configs/environments.json", "utf-8");
  const parsed: unknown = JSON.parse(raw);
  validateConfigShape(parsed);
  configCache = parsed;
  return configCache;
}

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const CRC_ENV_IMAGE = "ghcr.io/joeoc2001/code-remote-control-env:latest";

export function validateEnvironment(): void {
  const missing: string[] = [];
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

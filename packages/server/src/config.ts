import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentsFile } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfigurations(): EnvironmentsFile {
  const configPath = resolve(__dirname, "../../../configs/environments.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as EnvironmentsFile;
}

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const CRC_ENV_IMAGE = process.env.CRC_ENV_IMAGE || "crc-env:latest";

import { readFile } from "node:fs/promises";
import { configFileSchema, resolveConfigFile, type ResolvedConfigFile } from "./types.js";

let configCache: ResolvedConfigFile | null = null;

export const CRC_CONFIG_PATH = process.env.CRC_CONFIG_PATH || "/configs/environments.json";

export async function loadConfigurations(): Promise<ResolvedConfigFile> {
  if (configCache) return configCache;
  const raw = await readFile(CRC_CONFIG_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  configCache = resolveConfigFile(configFileSchema.parse(parsed));
  return configCache;
}

export interface ForgeToken {
  envName: string;
  value: string;
}

type Env = Record<string, string | undefined>;

export function agentToken(env: Env, envName: string): ForgeToken {
  return { envName, value: env[envName] || "" };
}

export function mergeToken(env: Env, agentEnvName: string, mergeEnvName: string): ForgeToken {
  const value = env[mergeEnvName];
  return value ? { envName: mergeEnvName, value } : agentToken(env, agentEnvName);
}

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const GITHUB_AGENT_TOKEN = agentToken(process.env, "GITHUB_TOKEN");
export const GITLAB_AGENT_TOKEN = agentToken(process.env, "GITLAB_TOKEN");
export const GITHUB_MERGE_TOKEN = mergeToken(process.env, "GITHUB_TOKEN", "GITHUB_MERGE_TOKEN");
export const GITLAB_MERGE_TOKEN = mergeToken(process.env, "GITLAB_TOKEN", "GITLAB_MERGE_TOKEN");
export const CRC_ENV_IMAGE =
  process.env.CRC_ENV_IMAGE || "ghcr.io/joeoc2001/code-remote-control-env:latest";
export const CRC_STATE_DIR = process.env.CRC_STATE_DIR || "/data";

const MERGE_TOKEN_PAIRS = [
  { agent: "GITHUB_TOKEN", merge: "GITHUB_MERGE_TOKEN" },
  { agent: "GITLAB_TOKEN", merge: "GITLAB_MERGE_TOKEN" },
];

export function validateEnvironment(env: Env = process.env): void {
  const missing: string[] = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  for (const { agent, merge } of MERGE_TOKEN_PAIRS) {
    if (!env[agent]) {
      if (env[merge]) throw new Error(`${merge} is set but ${agent} is not.`);
      continue;
    }
    if (!env[merge]) {
      console.warn(
        `${merge} is not set: merging approved Task PRs/MRs will use ${agent}, which may be refused under branch protection.`,
      );
    } else if (env[merge] === env[agent]) {
      throw new Error(`${merge} must differ from ${agent}: the merge token is meant to be more privileged than the agent token.`);
    }
  }
}

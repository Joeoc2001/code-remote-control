export interface HarnessFile {
  path: string;
  content: Buffer;
  mode: number;
}

export interface HarnessSetup {
  files: HarnessFile[];
  env: Record<string, string>;
}

export const HOOKS_DIR = "/opt/crc/hooks";
export const WORKSPACE_DIR = "/workspace";
export const GIT_HYGIENE_HOOK_TIMEOUT_SECONDS = 1230;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function jsonFile(path: string, content: unknown, mode: number): HarnessFile {
  return { path, content: Buffer.from(JSON.stringify(content)), mode };
}

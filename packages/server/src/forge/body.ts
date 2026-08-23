const STDIN_PLACEHOLDERS = new Set(["@-", "@", "-"]);

export function isStdinPlaceholderBody(body: string): boolean {
  return STDIN_PLACEHOLDERS.has(body.trim());
}

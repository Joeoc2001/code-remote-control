export const PLACEHOLDER_BODY_MARKERS = ["@-", "-"] as const;

export function isPlaceholderBody(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false;
  return (PLACEHOLDER_BODY_MARKERS as readonly string[]).includes(body.trim());
}

export function isMissingBody(body: string | null | undefined): boolean {
  return typeof body !== "string" || body.trim().length === 0;
}

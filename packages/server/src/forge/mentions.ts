import type { RepoReviewRequest, RepoWorkItem } from "../types.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsUrl(text: string, url: string): boolean {
  return new RegExp(`${escapeRegExp(url)}(?![\\w/-])`).test(text);
}

function mentionsReference(text: string, reference: string): boolean {
  if (!/^#\d+$/.test(reference)) return false;
  return new RegExp(`(?<![\\w/&])${escapeRegExp(reference)}(?!\\d)`).test(text);
}

export function mentionedWorkItems(
  reviewRequest: Pick<RepoReviewRequest, "title" | "body">,
  workItems: RepoWorkItem[],
): RepoWorkItem[] {
  const text = `${reviewRequest.title}\n${reviewRequest.body ?? ""}`;
  return workItems.filter((item) => mentionsUrl(text, item.url) || mentionsReference(text, item.reference));
}

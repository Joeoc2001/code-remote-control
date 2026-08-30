const { readFileSync } = require("node:fs");

const TASK_NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function launchedTaskIds(entry) {
  const result = isRecord(entry) ? entry.toolUseResult : null;
  if (!isRecord(result)) return [];

  const ids = [];
  if (typeof result.backgroundTaskId === "string") ids.push(result.backgroundTaskId);
  if (result.status === "async_launched" && typeof result.agentId === "string") ids.push(result.agentId);
  if (result.status === "remote_launched" && typeof result.taskId === "string") ids.push(result.taskId);
  return ids;
}

function collectStrings(value, into) {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
}

function notificationTexts(entry) {
  const texts = [];
  if (typeof entry.content === "string") texts.push(entry.content);
  if (isRecord(entry.attachment)) collectStrings(entry.attachment, texts);

  const message = isRecord(entry.message) ? entry.message : null;
  const content = message ? message.content : null;
  if (typeof content === "string") texts.push(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts;
}

function notifiedTaskIds(entry) {
  const ids = [];
  for (const text of notificationTexts(entry)) {
    if (!text.includes("<task-notification>")) continue;
    for (const [, body] of text.matchAll(TASK_NOTIFICATION_PATTERN)) {
      const match = body.match(TASK_ID_PATTERN);
      if (match) ids.push(match[1].trim());
    }
  }
  return ids;
}

function pendingBackgroundTaskIds(transcript) {
  const pending = new Set();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    for (const id of launchedTaskIds(entry)) pending.add(id);
    if (entry.type === "assistant" || !line.includes("<task-notification>")) continue;
    for (const id of notifiedTaskIds(entry)) pending.delete(id);
  }
  return [...pending];
}

function readPendingBackgroundTaskIds(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return [];

  let transcript;
  try {
    transcript = readFileSync(transcriptPath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return pendingBackgroundTaskIds(transcript);
}

module.exports = { pendingBackgroundTaskIds, readPendingBackgroundTaskIds };

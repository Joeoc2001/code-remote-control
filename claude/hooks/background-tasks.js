const { readdirSync, readFileSync, readlinkSync, realpathSync } = require("node:fs");

const TASK_NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;
const OUTPUT_FILE_PATTERN = /Output is being written to: (\S+?\.output)\b/;
const PROC_DIR = "/proc";

function runDir() {
  return process.env.CRC_RUN_DIR || "/run";
}

function sessionStartedAtPath() {
  return `${runDir()}/crc-session-started-at`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultTexts(entry) {
  const message = isRecord(entry.message) ? entry.message : null;
  if (!message || !Array.isArray(message.content)) return [];
  const texts = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    if (typeof block.content === "string") texts.push(block.content);
    if (Array.isArray(block.content)) {
      for (const item of block.content) {
        if (isRecord(item) && typeof item.text === "string") texts.push(item.text);
      }
    }
  }
  return texts;
}

function launchedOutputFile(entry) {
  for (const text of toolResultTexts(entry)) {
    const match = text.match(OUTPUT_FILE_PATTERN);
    if (match) return match[1];
  }
  return null;
}

function launchedTasks(entry) {
  const result = isRecord(entry) ? entry.toolUseResult : null;
  if (!isRecord(result)) return [];

  const tasks = [];
  if (typeof result.backgroundTaskId === "string") {
    tasks.push({ id: result.backgroundTaskId, outputFile: launchedOutputFile(entry) });
  }
  if (result.status === "async_launched" && typeof result.agentId === "string") {
    tasks.push({ id: result.agentId, outputFile: null });
  }
  if (result.status === "remote_launched" && typeof result.taskId === "string") {
    tasks.push({ id: result.taskId, outputFile: null });
  }
  return tasks;
}

function stoppedTaskIds(entry) {
  if (entry.type !== "assistant") return [];
  const message = isRecord(entry.message) ? entry.message : null;
  if (!message || !Array.isArray(message.content)) return [];

  const ids = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || block.name !== "TaskStop") continue;
    const input = isRecord(block.input) ? block.input : {};
    const id = typeof input.task_id === "string" ? input.task_id : input.shell_id;
    if (typeof id === "string") ids.push(id);
  }
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

function predatesSession(entry, sinceMs) {
  if (sinceMs === null || typeof entry.timestamp !== "string") return false;
  const at = Date.parse(entry.timestamp);
  return !Number.isNaN(at) && at < sinceMs;
}

function pendingBackgroundTasks(transcript, { since = null } = {}) {
  const sinceMs = since === null ? null : Date.parse(since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`background-tasks.js: invalid session start '${since}'`);

  const pending = new Map();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || predatesSession(entry, sinceMs)) continue;

    for (const task of launchedTasks(entry)) pending.set(task.id, task);
    for (const id of stoppedTaskIds(entry)) pending.delete(id);
    if (entry.type === "assistant" || !line.includes("<task-notification>")) continue;
    for (const id of notifiedTaskIds(entry)) pending.delete(id);
  }
  return [...pending.values()];
}

function readSessionStartedAt() {
  let raw;
  try {
    raw = readFileSync(sessionStartedAtPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const since = raw.trim();
  if (Number.isNaN(Date.parse(since))) {
    throw new Error(`background-tasks.js: ${sessionStartedAtPath()} does not hold a timestamp: '${since}'`);
  }
  return since;
}

function resolvedPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function isHeldOpenByAnyProcess(file) {
  const targets = new Set([file, resolvedPath(file)]);
  for (const pid of readdirSync(PROC_DIR)) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try {
      fds = readdirSync(`${PROC_DIR}/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = readlinkSync(`${PROC_DIR}/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (targets.has(link)) return true;
    }
  }
  return false;
}

function isStillRunning(task) {
  return task.outputFile === null || isHeldOpenByAnyProcess(task.outputFile);
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
  return pendingBackgroundTasks(transcript, { since: readSessionStartedAt() })
    .filter(isStillRunning)
    .map((task) => task.id);
}

module.exports = {
  isHeldOpenByAnyProcess,
  pendingBackgroundTasks,
  readPendingBackgroundTaskIds,
  readSessionStartedAt,
  sessionStartedAtPath,
};

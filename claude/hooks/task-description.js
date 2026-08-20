const { writeFileSync } = require("node:fs");

const TASK_DESCRIPTION_PATH = "/run/crc-current-task-description";
const MAX_LENGTH = 500;

function isResumePrompt(prompt) {
  const resumePrompt = process.env.CRC_RESUME_PROMPT;
  return Boolean(resumePrompt) && prompt === resumePrompt;
}

function taskDescriptionFor(prompt) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmed || isResumePrompt(trimmed)) return null;
  return trimmed.replace(/\s+/g, " ").slice(0, MAX_LENGTH);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw);
  const description = taskDescriptionFor(payload.prompt);
  if (!description) return;

  writeFileSync(TASK_DESCRIPTION_PATH, `${description}\n`, { encoding: "utf-8", mode: 0o644 });
}

module.exports = { TASK_DESCRIPTION_PATH, taskDescriptionFor };

if (require.main === module) {
  main();
}

const { writeFileSync } = require("node:fs");

const TASK_DESCRIPTION_PATH = "/run/crc-current-task-description";
const MAX_LENGTH = 500;

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
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) return;

  const description = prompt.replace(/\s+/g, " ").slice(0, MAX_LENGTH);
  writeFileSync(TASK_DESCRIPTION_PATH, `${description}\n`, { encoding: "utf-8", mode: 0o644 });
}

main();

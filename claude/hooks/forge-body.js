const { FORGE_BODY_GUIDANCE, STDIN_MARKERS: MARKER_LIST } = require("./forge-body-guidance.js");

const STDIN_MARKERS = new Set(MARKER_LIST);
const FORGE_COMMANDS = new Set(["gh", "glab"]);
const VERBATIM_BODY_FLAGS = ["--body", "--description", "--message", "-b", "-d", "-m"];
const OPERATORS = new Set([";", "&", "|", "(", ")", "\n"]);

function splitCommand(command) {
  const segments = [];
  let tokens = [];
  let token = "";
  let started = false;
  let quote = null;

  const endToken = () => {
    if (started) tokens.push(token);
    token = "";
    started = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\" && i + 1 < command.length) token += command[++i];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      token += command[++i];
      started = true;
      continue;
    }
    if (OPERATORS.has(char)) {
      endSegment();
      continue;
    }
    if (/\s/.test(char)) {
      endToken();
      continue;
    }
    token += char;
    started = true;
  }

  endSegment();
  return segments;
}

function attachedValue(token, flag) {
  if (!token.startsWith(flag)) return null;
  const rest = token.slice(flag.length);
  if (rest === "") return null;
  if (flag.startsWith("--")) return rest.startsWith("=") ? rest.slice(1) : null;
  return rest.startsWith("=") ? rest.slice(1) : rest;
}

function segmentViolation(tokens) {
  const program = tokens[0].split("/").pop();
  if (!FORGE_COMMANDS.has(program)) return null;

  for (let i = 1; i < tokens.length; i++) {
    for (const flag of VERBATIM_BODY_FLAGS) {
      if (tokens[i] === flag) {
        if (STDIN_MARKERS.has(tokens[i + 1])) return { program, flag, value: tokens[i + 1] };
        continue;
      }
      const value = attachedValue(tokens[i], flag);
      if (value !== null && STDIN_MARKERS.has(value)) return { program, flag, value };
    }
  }
  return null;
}

function findForgeBodyViolation(command) {
  if (typeof command !== "string") return null;
  for (const tokens of splitCommand(command)) {
    const violation = segmentViolation(tokens);
    if (violation) return violation;
  }
  return null;
}

function denialReason(violation) {
  return `Blocked: \`${violation.program} ${violation.flag} ${violation.value}\` posts the literal characters \`${violation.value}\` as the body. ${FORGE_BODY_GUIDANCE}`;
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
  const payload = JSON.parse(await readStdin());
  if (payload.tool_name !== "Bash") return;

  const violation = findForgeBodyViolation(payload.tool_input?.command);
  if (!violation) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denialReason(violation),
      },
    }),
  );
}

module.exports = { findForgeBodyViolation, denialReason };

if (require.main === module) {
  main();
}

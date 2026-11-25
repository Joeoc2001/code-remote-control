const HARNESSES = ["claude", "antigravity"];

function optionFromArgv(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? "");
}

function harnessFromArgv(argv) {
  const harness = optionFromArgv(argv, "--harness") ?? "claude";
  if (!HARNESSES.includes(harness)) {
    throw new Error(`--harness expects one of ${HARNESSES.join(", ")}, got '${harness}'`);
  }
  return harness;
}

const PAYLOAD_READERS = {
  claude: (payload) => ({
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    prompt: payload.prompt,
    continuedByStopHook: Boolean(payload.stop_hook_active),
    backgroundBusy: false,
    cancelledByUser: false,
  }),
  antigravity: (payload) => ({
    sessionId: payload.conversationId,
    transcriptPath: payload.transcriptPath,
    prompt: payload.lastUserInput,
    continuedByStopHook: payload.executionNum > 0 || payload.continuationActive === true,
    backgroundBusy: payload.fullyIdle === false,
    cancelledByUser: payload.terminationReason === "USER_CANCELED",
  }),
};

const REPLIES = {
  claude: {
    event: () => "",
    stopAllowed: () => "",
    stopBlocked: (reason) => JSON.stringify({ decision: "block", reason }),
  },
  antigravity: {
    event: (event) => (event === "PreToolUse" ? JSON.stringify({ decision: "allow" }) : "{}"),
    stopAllowed: () => "{}",
    stopBlocked: (reason) => JSON.stringify({ decision: "continue", reason }),
  },
};

function readPayload(harness, payload) {
  return PAYLOAD_READERS[harness](payload);
}

function reply(harness) {
  return REPLIES[harness];
}

module.exports = { HARNESSES, harnessFromArgv, optionFromArgv, readPayload, reply };

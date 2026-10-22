export const CLAUDE_TMUX_SESSION = "crc";

export function buildPokeCommands(session: string, message: string): { type: string[]; submit: string[] } {
  if (message.length === 0 || /[\r\n]/.test(message)) {
    throw new Error("A poke message must be a single non-empty line");
  }
  return {
    type: ["tmux", "send-keys", "-t", session, "-l", message],
    submit: ["tmux", "send-keys", "-t", session, "Enter"],
  };
}

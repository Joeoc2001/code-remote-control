const reminderFingerprintBySession = new Map();

async function getGitState($) {
  const insideWorktree = (await $`git rev-parse --is-inside-work-tree`.nothrow().text()).trim();
  if (insideWorktree !== "true") return null;

  const uncommittedOutput = await $`git status --porcelain`.text();
  const hasUncommittedChanges = uncommittedOutput.trim().length > 0;

  const upstreamOutput = await $`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`.nothrow().text();
  const upstream = upstreamOutput.trim();
  let hasUnpushedCommits = false;
  let aheadCount = 0;

  if (upstream.length > 0) {
    const aheadOutput = await $`git rev-list --count ${upstream}..HEAD`.text();
    aheadCount = Number.parseInt(aheadOutput.trim(), 10) || 0;
    hasUnpushedCommits = aheadCount > 0;
  } else {
    const unpushedAnywhere = await $`git log --branches --not --remotes --max-count=1 --format=%H`.nothrow().text();
    hasUnpushedCommits = unpushedAnywhere.trim().length > 0;
  }

  return {
    hasUncommittedChanges,
    hasUnpushedCommits,
    upstream,
    aheadCount,
  };
}

export const GitHygienePlugin = async ({ client, $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const gitState = await getGitState($);
      if (!gitState) return;

      if (!gitState.hasUncommittedChanges && !gitState.hasUnpushedCommits) {
        reminderFingerprintBySession.delete(event.properties.sessionID);
        return;
      }

      const fingerprint = `${gitState.hasUncommittedChanges}:${gitState.hasUnpushedCommits}:${gitState.upstream}:${gitState.aheadCount}`;
      if (reminderFingerprintBySession.get(event.properties.sessionID) === fingerprint) return;

      reminderFingerprintBySession.set(event.properties.sessionID, fingerprint);

      const reminder = gitState.hasUncommittedChanges && gitState.hasUnpushedCommits
        ? "Before your next task, commit your outstanding workspace changes and push your local commits to remote."
        : gitState.hasUncommittedChanges
          ? "Before your next task, commit your outstanding workspace changes."
          : "Before your next task, push your local commits to remote.";

      await client.session.prompt({
        path: { id: event.properties.sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: reminder }],
        },
      });
    },
  };
};

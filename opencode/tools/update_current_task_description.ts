import { tool } from "@opencode-ai/plugin";
import { writeFile } from "node:fs/promises";

const TASK_DESCRIPTION_PATH = "/run/opencode-current-task-description";

export default tool({
  description:
    "Persist the user's current task description for container metadata. Call this immediately when a user assigns a new task, then call it again whenever the task changes.",
  args: {
    taskDescription: tool.schema
      .string()
      .min(1)
      .max(500)
      .describe("A short, plain-language description of the active task."),
  },
  async execute(args) {
    const taskDescription = args.taskDescription.trim();

    if (!taskDescription) {
      throw new Error("taskDescription must not be empty");
    }

    await writeFile(TASK_DESCRIPTION_PATH, `${taskDescription}\n`, {
      encoding: "utf-8",
      mode: 0o644,
    });

    return {
      ok: true,
      taskDescription,
      path: TASK_DESCRIPTION_PATH,
    };
  },
});

import type { TaskStep } from "../types";

export const TASK_STEP_LABELS: Record<TaskStep, string> = {
  implement: "Implement",
  fix_ci: "Fix CI",
  rebase: "Rebase",
  review: "Review",
  address_comments: "Address comments",
};

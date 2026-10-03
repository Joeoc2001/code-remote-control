export type ForgeProvider = "github" | "gitlab" | "none";

export interface ReviewRequestStatus {
  id: string;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
}

export interface PipelineStatus {
  status: string;
  url: string | null;
}

export type InstanceState =
  | "working"
  | "waiting"
  | "awaiting-background"
  | "finished";

export type PendingTaskKind = "shell" | "agent" | "remote";

export interface PendingTask {
  id: string;
  kind: PendingTaskKind;
  label: string;
}

export interface InstanceStatus {
  state: InstanceState;
  pendingTasks?: PendingTask[];
  updatedAt: string | null;
}

export interface ContainerCodeStatus {
  branch: string;
  commitSha: string;
  orgName: string | null;
  repoName: string | null;
  provider: ForgeProvider;
  currentTaskDescription: string | null;
  createdIssueUrl: string | null;
  reviewRequest: ReviewRequestStatus | null;
  pipeline: PipelineStatus | null;
  warnings: string[];
  updatedAt: string;
}

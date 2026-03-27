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

export interface ContainerCodeStatus {
  branch: string;
  commitSha: string;
  provider: ForgeProvider;
  reviewRequest: ReviewRequestStatus | null;
  pipeline: PipelineStatus | null;
  warnings: string[];
  updatedAt: string;
}

import { z } from "zod";
import { TASK_STEPS, type ManagedContainer } from "@crc/shared";

export type {
  EnvironmentConfig,
  ResolvedEnvironmentConfig,
  DockerConfig,
  AgentKind,
  ClaudeOauth,
  ResolvedClaudeConfig,
  ResolvedAntigravityConfig,
  ConfigFile,
  ResolvedConfigFile,
  ConfigSummary,
  ConfigSummaryFile,
  ContainerHealth,
  ManagedContainer,
  CreateContainerRequest,
  CreateContainerRequestV2,
  CreateContainersRequest,
  CreateContainersResponse,
  CreateQuickPromptRequest,
  AttachableReviewRequest,
  CreateTaskFromReviewRequestRequest,
  CreateTaskFromTextRequest,
  CreateTasksRequest,
  CreateTasksResponse,
  ClosureNotice,
  GitHubRepo,
  GitLabRepo,
  MergeMethod,
  LaunchQuickPromptRequest,
  QuickPrompt,
  RepoWorkItem,
  RepoReviewRequest,
  RepoSource,
  ReviewRequestCiState,
  ReviewRequestState,
  SSEEvent,
  Task,
  TaskApproval,
  TaskAttempt,
  TaskPhase,
  TaskReviewRequestRef,
  TaskStage,
  TaskStep,
  UpdateQuickPromptRequest,
  UpdateTaskRequest,
} from "@crc/shared";

export {
  agentKindSchema,
  DEFAULT_AGENT_KIND,
  configFileSchema,
  currentStageFirstAttemptIndex,
  environmentConfigSchema,
  gitConfigSchema,
  resolveConfigFile,
  TASK_STEPS,
} from "@crc/shared";

export const taskSpawnSchema = z.object({
  taskId: z.string().min(1),
  step: z.enum(TASK_STEPS),
  headShaBefore: z.string().nullable(),
  diffHashBefore: z.string().nullable(),
});

export type TaskSpawn = z.infer<typeof taskSpawnSchema>;

export interface TaskContainer {
  container: ManagedContainer;
  spawn: TaskSpawn | null;
}

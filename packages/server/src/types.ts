import { z } from "zod";
import { TASK_STEPS, type ManagedContainer } from "@crc/shared";

export type {
  EnvironmentConfig,
  ResolvedEnvironmentConfig,
  DockerConfig,
  ClaudeOauth,
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
  CreateTasksRequest,
  CreateTasksResponse,
  GitHubRepo,
  GitLabRepo,
  MergeMethod,
  RepoWorkItem,
  RepoReviewRequest,
  RepoSource,
  ReviewRequestCiState,
  ReviewRequestState,
  SSEEvent,
  Task,
  TaskAttempt,
  TaskPhase,
  TaskReviewRequestRef,
  TaskStep,
  UpdateTaskRequest,
} from "@crc/shared";

export {
  configFileSchema,
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
  spawn: TaskSpawn;
}

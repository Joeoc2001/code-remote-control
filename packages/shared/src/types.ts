import { z } from "zod";

export const gitConfigSchema = z.object({
  email: z.string(),
  username: z.string(),
});

const dockerDeviceSchema = z.object({
  path_on_host: z.string().min(1),
  path_in_container: z.string().min(1).optional(),
  cgroup_permissions: z.string().optional(),
});

const dockerDeviceRequestSchema = z.object({
  driver: z.string().optional(),
  count: z.number().int().optional(),
  device_ids: z.array(z.string().min(1)).optional(),
  capabilities: z.array(z.array(z.string().min(1)).min(1)).min(1).optional(),
  options: z.record(z.string(), z.string()).optional(),
});

const dockerUlimitSchema = z.object({
  name: z.string().min(1),
  soft: z.number().int(),
  hard: z.number().int(),
});

const dockerRestartPolicySchema = z.object({
  name: z.string().min(1),
  maximum_retry_count: z.number().int().min(0).optional(),
});

export const dockerConfigSchema = z.object({
  auto_remove: z
    .literal(false, {
      error:
        "docker.auto_remove must not be enabled: it deletes the container on exit, which discards the workspace and the Claude Code transcripts needed to resume the session after a restart",
    })
    .optional(),
  network_mode: z.string().min(1).optional(),
  networks: z.array(z.string().min(1)).optional(),
  network_aliases: z.array(z.string().min(1)).optional(),
  binds: z.array(z.string().min(1)).optional(),
  tmpfs: z.record(z.string(), z.string()).optional(),
  shm_size: z.number().int().positive().optional(),
  memory: z.number().int().positive().optional(),
  memory_swap: z.number().int().optional(),
  nano_cpus: z.number().int().positive().optional(),
  cpu_shares: z.number().int().positive().optional(),
  cpuset_cpus: z.string().min(1).optional(),
  cap_add: z.array(z.string().min(1)).optional(),
  cap_drop: z.array(z.string().min(1)).optional(),
  security_opt: z.array(z.string().min(1)).optional(),
  privileged: z.boolean().optional(),
  readonly_rootfs: z.boolean().optional(),
  extra_hosts: z.array(z.string().min(1)).optional(),
  dns: z.array(z.string().min(1)).optional(),
  dns_search: z.array(z.string().min(1)).optional(),
  devices: z.array(dockerDeviceSchema).optional(),
  device_cgroup_rules: z.array(z.string().min(1)).optional(),
  device_requests: z.array(dockerDeviceRequestSchema).optional(),
  runtime: z.string().min(1).optional(),
  restart_policy: dockerRestartPolicySchema.optional(),
  ulimits: z.array(dockerUlimitSchema).optional(),
});

export const claudeOauthSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().optional(),
  scopes: z.array(z.string().min(1)).optional(),
  subscriptionType: z.string().min(1).optional(),
});

const configDefaultsSchema = z.object({
  oauth: claudeOauthSchema.optional(),
  claude: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  docker: dockerConfigSchema.optional(),
});

export const environmentConfigSchema = configDefaultsSchema.extend({
  name: z.string().min(1),
});

export const mergeMethodSchema = z.enum(["merge", "squash", "rebase"]);

export const configFileSchema = configDefaultsSchema.extend({
  root_domain: z.string(),
  git: gitConfigSchema,
  gitlab_url: z.string().optional(),
  merge_method: mergeMethodSchema.optional(),
  configurations: z.array(environmentConfigSchema),
});

export type GitConfig = z.infer<typeof gitConfigSchema>;
export type MergeMethod = z.infer<typeof mergeMethodSchema>;
export type DockerConfig = z.infer<typeof dockerConfigSchema>;
export type ClaudeOauth = z.infer<typeof claudeOauthSchema>;
export type ConfigDefaults = z.infer<typeof configDefaultsSchema>;
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

export type ResolvedEnvironmentConfig = EnvironmentConfig & { oauth: ClaudeOauth };
export type ResolvedConfigFile = Omit<ConfigFile, "configurations"> & {
  configurations: ResolvedEnvironmentConfig[];
};

function mergeBlock<T extends object>(defaults: T | undefined, override: T | undefined): T | undefined {
  if (!defaults) return override;
  if (!override) return defaults;
  return { ...defaults, ...override };
}

export function resolveEnvironmentConfig(
  defaults: ConfigDefaults,
  config: EnvironmentConfig,
): ResolvedEnvironmentConfig {
  const oauth = mergeBlock(defaults.oauth, config.oauth);
  if (!oauth) {
    throw new Error(
      `Configuration '${config.name}' has no oauth block and no top-level oauth default is set`,
    );
  }
  return {
    name: config.name,
    oauth,
    claude: mergeBlock(defaults.claude, config.claude),
    env: mergeBlock(defaults.env, config.env),
    docker: mergeBlock(defaults.docker, config.docker),
  };
}

export function resolveConfigFile(file: ConfigFile): ResolvedConfigFile {
  return {
    ...file,
    configurations: file.configurations.map((config) =>
      resolveEnvironmentConfig(file, config),
    ),
  };
}

export interface ContainerHealth {
  container: "running" | "stopped" | "error";
  claude: "healthy" | "unhealthy" | "unknown";
}

export interface ManagedContainer {
  id: string;
  name: string;
  configName: string;
  repoName: string;
  status: string;
  health: ContainerHealth;
  subdomain: string;
  createdAt: string;
}

export interface CreateContainerRequest {
  configName: string;
  repoFullName: string;
}

export interface ConfigSummary {
  name: string;
}

export interface ConfigSummaryFile {
  root_domain: string;
  configurations: ConfigSummary[];
}

export interface GitHubRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export interface GitLabRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export type RepoSource = "github" | "gitlab";

export interface CreateContainerRequestV2 {
  configName: string;
  repoFullName: string;
  repoSource: RepoSource;
  initialPrompt?: string;
}

export interface CreateContainersRequest {
  configName: string;
  repoFullName: string;
  repoSource: RepoSource;
  prompts: string[];
}

export interface CreateContainersResponse {
  containers: ManagedContainer[];
  errors: Array<{ prompt: string; error: string }>;
}

export interface RepoWorkItem {
  id: string;
  reference: string;
  title: string;
  url: string;
  body: string | null;
  kind: "issue" | "work_item";
}

export type ReviewRequestState = "open" | "merged" | "closed";

export type ReviewRequestCiState = "none" | "pending" | "running" | "success" | "failed";

export interface RepoReviewRequest {
  id: string;
  reference: string;
  title: string;
  url: string;
  body: string | null;
  kind: "pull_request" | "merge_request";
  state: ReviewRequestState;
  headSha: string;
  ciState: ReviewRequestCiState;
  hasConflicts: boolean;
  needsRebase: boolean;
  mergeStateKnown: boolean;
  approvedByHuman: boolean;
  hasUnresolvedComments: boolean;
  hasPlaceholderComment: boolean;
}

export const TASK_STEPS = ["implement", "fix_ci", "rebase", "review", "address_comments"] as const;

export type TaskStep = (typeof TASK_STEPS)[number];

export type TaskPhase =
  | "spawning"
  | "agent_running"
  | "waiting_ci"
  | "waiting_approval"
  | "merging"
  | "merged"
  | "failed"
  | "paused";

export interface TaskAttempt {
  step: TaskStep;
  containerId: string | null;
  headShaBefore: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface TaskReviewRequestRef {
  id: string;
  url: string;
  sourceBranch: string;
}

export interface Task {
  id: string;
  repoFullName: string;
  repoSource: RepoSource;
  workItem: RepoWorkItem;
  configByStep: Record<TaskStep, string>;
  phase: TaskPhase;
  reviewRequest: TaskReviewRequestRef | null;
  lastReviewedSha: string | null;
  activeContainerId: string | null;
  activeStep: TaskStep | null;
  attemptsByStep: Record<TaskStep, number>;
  attempts: TaskAttempt[];
  consecutiveErrors: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTasksRequest {
  repoFullName: string;
  repoSource: RepoSource;
  workItemIds: string[];
  configName: string;
  configByStep?: Partial<Record<TaskStep, string>>;
}

export interface CreateTasksResponse {
  tasks: Task[];
  errors: Array<{ workItemId: string; error: string }>;
}

export interface UpdateTaskRequest {
  phase?: "paused" | "resume";
  configByStep?: Partial<Record<TaskStep, string>>;
}

export type SSEEvent =
  | { type: "container-updated"; data: ManagedContainer }
  | { type: "container-removed"; data: { id: string } }
  | { type: "task-updated"; data: Task }
  | { type: "task-removed"; data: { id: string } };

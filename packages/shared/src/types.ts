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
  auto_remove: z.boolean().optional(),
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

export const environmentConfigSchema = z.object({
  name: z.string().min(1),
  opencode: z.record(z.string(), z.unknown()),
  env: z.record(z.string(), z.string()).optional(),
  docker: dockerConfigSchema.optional(),
});

export const configFileSchema = z.object({
  root_domain: z.string(),
  git: gitConfigSchema,
  gitlab_url: z.string().optional(),
  configurations: z.array(environmentConfigSchema),
});

export type GitConfig = z.infer<typeof gitConfigSchema>;
export type DockerConfig = z.infer<typeof dockerConfigSchema>;
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

export interface ContainerHealth {
  container: "running" | "stopped" | "error";
  openCode: "healthy" | "unhealthy" | "unknown";
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
}

export type SSEEvent =
  | { type: "container-updated"; data: ManagedContainer }
  | { type: "container-removed"; data: { id: string } };

import Dockerode from "dockerode";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import tar from "tar-stream";
import type {
  ManagedContainer,
  ContainerHealth,
  EnvironmentConfig,
  ConfigFile,
  DockerConfig,
  ClaudeOauth,
} from "./types.js";
import { GITHUB_TOKEN, GITLAB_TOKEN, CRC_ENV_IMAGE } from "./config.js";


import type { RepoSource } from "./types.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export const CONTAINER_INTERNAL_PORT = 8080;
export const CONTAINER_METADATA_INTERNAL_PORT = 8081;
const CONTAINER_PREFIX = "crc-";
const LABEL_CONFIG_NAME = "crc.config-name";
const LABEL_REPO_NAME = "crc.repo-name";
const LABEL_SUBDOMAIN = "crc.subdomain";
const HEALTH_CHECK_TIMEOUT_MS = 1_000;
const CLAUDE_SETTINGS_RELATIVE_PATH = "root/.claude/settings.json";
const CLAUDE_CREDENTIALS_RELATIVE_PATH = "root/.claude/.credentials.json";
const CLAUDE_CONFIG_RELATIVE_PATH = "root/.claude.json";
const CLAUDE_HOOKS_DIR = "/opt/crc/claude-hooks";

type ClaudeSettings = Record<string, unknown>;
type DockerHostConfig = NonNullable<Dockerode.ContainerCreateOptions["HostConfig"]>;
type DockerDevice = NonNullable<DockerConfig["devices"]>[number];
type DockerDeviceRequest = NonNullable<DockerConfig["device_requests"]>[number];
type DockerUlimit = NonNullable<DockerConfig["ulimits"]>[number];

interface CreateContainerOptions {
  initialPrompt?: string;
  pullImage?: boolean;
}

const DEFAULT_RESTART_MAX_RETRIES = 3;

function buildRestartPolicy(dockerConfig: DockerConfig | undefined): DockerHostConfig["RestartPolicy"] {
  const name = dockerConfig?.restart_policy?.name ?? "on-failure";
  const maximumRetryCount = name === "on-failure"
    ? dockerConfig?.restart_policy?.maximum_retry_count ?? DEFAULT_RESTART_MAX_RETRIES
    : dockerConfig?.restart_policy?.maximum_retry_count;
  return { Name: name, MaximumRetryCount: maximumRetryCount };
}

function buildHostConfig(dockerConfig: DockerConfig | undefined): DockerHostConfig {
  return {
    AutoRemove: dockerConfig?.auto_remove ?? false,
    NetworkMode: dockerConfig?.network_mode,
    Binds: dockerConfig?.binds,
    Tmpfs: dockerConfig?.tmpfs,
    ShmSize: dockerConfig?.shm_size,
    Memory: dockerConfig?.memory,
    MemorySwap: dockerConfig?.memory_swap,
    NanoCpus: dockerConfig?.nano_cpus,
    CpuShares: dockerConfig?.cpu_shares,
    CpusetCpus: dockerConfig?.cpuset_cpus,
    CapAdd: dockerConfig?.cap_add,
    CapDrop: dockerConfig?.cap_drop,
    SecurityOpt: dockerConfig?.security_opt,
    Privileged: dockerConfig?.privileged,
    ReadonlyRootfs: dockerConfig?.readonly_rootfs,
    ExtraHosts: dockerConfig?.extra_hosts,
    Dns: dockerConfig?.dns,
    DnsSearch: dockerConfig?.dns_search,
    Devices: dockerConfig?.devices?.map((device: DockerDevice) => ({
      PathOnHost: device.path_on_host,
      PathInContainer: device.path_in_container ?? device.path_on_host,
      CgroupPermissions: device.cgroup_permissions,
    })),
    DeviceCgroupRules: dockerConfig?.device_cgroup_rules,
    DeviceRequests: dockerConfig?.device_requests?.map((request: DockerDeviceRequest) => ({
      Driver: request.driver,
      Count: request.count,
      DeviceIDs: request.device_ids,
      Capabilities: request.capabilities,
      Options: request.options,
    })),
    Runtime: dockerConfig?.runtime,
    RestartPolicy: buildRestartPolicy(dockerConfig),
    Ulimits: dockerConfig?.ulimits?.map((ulimit: DockerUlimit) => ({
      Name: ulimit.name,
      Soft: ulimit.soft,
      Hard: ulimit.hard,
    })),
  };
}

function buildEndpointConfig(
  dockerConfig: DockerConfig | undefined,
): { Aliases?: string[] } | undefined {
  if (!dockerConfig?.network_aliases || dockerConfig.network_aliases.length === 0) {
    return undefined;
  }

  return {
    Aliases: dockerConfig.network_aliases,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FORCED_ALLOWED_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

function buildClaudePermissions(permissions: unknown): Record<string, unknown> {
  const permissionsRecord = isRecord(permissions) ? permissions : {};
  const existingAllow = Array.isArray(permissionsRecord.allow)
    ? permissionsRecord.allow.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    ...permissionsRecord,
    defaultMode: "acceptEdits",
    allow: [...new Set([...existingAllow, ...FORCED_ALLOWED_TOOLS])],
  };
}

const GIT_HYGIENE_HOOK_TIMEOUT_SECONDS = 1230;

function buildClaudeHooks(): Record<string, unknown> {
  const command = (script: string, timeout?: number) => ({
    hooks: [{ type: "command", command: `node ${CLAUDE_HOOKS_DIR}/${script}`, ...(timeout ? { timeout } : {}) }],
  });

  return {
    UserPromptSubmit: [command("task-description.js")],
    Stop: [command("git-hygiene.js", GIT_HYGIENE_HOOK_TIMEOUT_SECONDS)],
  };
}

function buildClaudeSettings(config: ClaudeSettings | undefined): ClaudeSettings {
  const baseConfig = isRecord(config) ? config : {};

  return {
    ...baseConfig,
    permissions: buildClaudePermissions(baseConfig.permissions),
    hooks: buildClaudeHooks(),
  };
}

function buildClaudeCredentials(oauth: ClaudeOauth): Record<string, unknown> {
  return { claudeAiOauth: oauth };
}

function buildClaudeConfig(): Record<string, unknown> {
  return {
    hasCompletedOnboarding: true,
    theme: "dark",
  };
}

interface TarEntry {
  path: string;
  content: Buffer;
  mode: number;
}

function createTar(entries: TarEntry[]): Promise<Buffer> {
  const pack = tar.pack();

  const addEntry = (index: number): void => {
    if (index >= entries.length) {
      pack.finalize();
      return;
    }
    const entry = entries[index];
    pack.entry({ name: entry.path, mode: entry.mode }, entry.content, (err) => {
      if (err) {
        pack.destroy(err);
        return;
      }
      addEntry(index + 1);
    });
  };

  addEntry(0);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
}

const healthCache = new Map<string, ContainerHealth>();
const logWatchers = new Map<string, NodeJS.ReadableStream>();

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 30);
}

function generateId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function demuxDockerStream(rawStream: NodeJS.ReadableStream): NodeJS.ReadableStream {
  const output = new PassThrough();
  docker.modem.demuxStream(rawStream as unknown as NodeJS.ReadWriteStream, output, output);
  rawStream.on("end", () => output.end());
  rawStream.on("error", (err) => output.destroy(err));
  return output;
}

async function assertManagedContainer(id: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const name = info.Name.replace(/^\//, "");
  if (!name.startsWith(CONTAINER_PREFIX)) {
    throw new Error("Container is not managed by CRC");
  }
}

function buildManagedContainer(
  id: string,
  name: string,
  labels: Record<string, string>,
  status: string,
  createdAt: string | number,
): ManagedContainer {
  const configName = labels[LABEL_CONFIG_NAME] || "unknown";
  const repoName = labels[LABEL_REPO_NAME] || "unknown";
  const subdomain = labels[LABEL_SUBDOMAIN] || "";

  const health = healthCache.get(id) || {
    container: status === "running" ? "running" as const : "stopped" as const,
    claude: "unknown" as const,
  };

  const createdAtStr = typeof createdAt === "number"
    ? new Date(createdAt * 1000).toISOString()
    : createdAt;

  return {
    id,
    name,
    configName,
    repoName,
    status,
    health,
    subdomain,
    createdAt: createdAtStr,
  };
}

function parseContainerInfo(container: Dockerode.ContainerInfo): ManagedContainer {
  const name = (container.Names[0] || "").replace(/^\//, "");
  const status = container.State || "unknown";

  return buildManagedContainer(
    container.Id,
    name,
    container.Labels,
    status,
    container.Created,
  );
}

export async function listContainers(): Promise<ManagedContainer[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { name: [CONTAINER_PREFIX] },
  });

  return containers
    .filter((c) => {
      const name = (c.Names[0] || "").replace(/^\//, "");
      return name.startsWith(CONTAINER_PREFIX);
    })
    .map(parseContainerInfo);
}

export async function getContainer(id: string): Promise<ManagedContainer | null> {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    const name = info.Name.replace(/^\//, "");
    if (!name.startsWith(CONTAINER_PREFIX)) return null;

    const status = info.State.Running ? "running" : info.State.Status;

    return buildManagedContainer(
      info.Id,
      name,
      info.Config.Labels,
      status,
      info.Created,
    );
  } catch {
    return null;
  }
}

export async function createContainer(
  appConfig: ConfigFile,
  config: EnvironmentConfig,
  repoFullName: string,
  repoSource: RepoSource = "github",
  options: CreateContainerOptions = {},
): Promise<ManagedContainer> {
  if (options.pullImage !== false) {
    try {
      await pullLatestImage();
    } catch (err) {
      console.warn("Failed to pull latest image, using locally available image:", err);
    }
  }

  const gitlabUrl = appConfig.gitlab_url || "https://gitlab.com";

  const repoShortName = slugify(repoFullName.split("/").pop() || "repo");
  const subdomain = `${slugify(config.name)}-${repoShortName}-${generateId()}`;
  const containerName = `${CONTAINER_PREFIX}${subdomain}`;
  const gitlabHost = gitlabUrl.replace(/\/+$/, "");
  const repoUrl = repoSource === "gitlab"
    ? `${gitlabHost}/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  const envVars = [
    `REPO_URL=${repoUrl}`,
    ...(repoSource === "github" && GITHUB_TOKEN ? [`GITHUB_TOKEN=${GITHUB_TOKEN}`] : []),
    ...(repoSource === "gitlab" && GITLAB_TOKEN ? [`GITLAB_TOKEN=${GITLAB_TOKEN}`] : []),
    `GITLAB_URL=${gitlabUrl}`,
    `CRC_REPO_SOURCE=${repoSource}`,
    `CRC_METADATA_PORT=${CONTAINER_METADATA_INTERNAL_PORT}`,
    `GIT_USER_NAME=${appConfig.git.username}`,
    `GIT_USER_EMAIL=${appConfig.git.email}`,
    ...(options.initialPrompt ? [`CRC_INITIAL_PROMPT=${options.initialPrompt}`] : []),
    ...Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
  ];

  const image = CRC_ENV_IMAGE;
  const hostConfig = buildHostConfig(config.docker);

  const container = await docker.createContainer({
    Image: image,
    name: containerName,
    Env: envVars,
    Labels: {
      [LABEL_CONFIG_NAME]: config.name,
      [LABEL_REPO_NAME]: repoFullName,
      [LABEL_SUBDOMAIN]: subdomain,
    },
    HostConfig: hostConfig,
  });

  try {
    const settingsJson = Buffer.from(JSON.stringify(buildClaudeSettings(config.claude)));
    const credentialsJson = Buffer.from(JSON.stringify(buildClaudeCredentials(config.oauth)));
    const configJson = Buffer.from(JSON.stringify(buildClaudeConfig()));
    const claudeTar = await createTar([
      { path: CLAUDE_SETTINGS_RELATIVE_PATH, content: settingsJson, mode: 0o444 },
      { path: CLAUDE_CREDENTIALS_RELATIVE_PATH, content: credentialsJson, mode: 0o600 },
      { path: CLAUDE_CONFIG_RELATIVE_PATH, content: configJson, mode: 0o600 },
    ]);
    await container.putArchive(claudeTar, { path: "/" });

    const endpointConfig = buildEndpointConfig(config.docker);
    const networkNames = config.docker?.networks || [];
    for (const networkName of networkNames) {
      const network = docker.getNetwork(networkName);
      await network.connect({
        Container: container.id,
        EndpointConfig: endpointConfig,
      });
    }

    await container.start();

    const info = await container.inspect();
    return buildManagedContainer(
      info.Id,
      containerName,
      info.Config.Labels,
      "running",
      info.Created,
    );
  } catch (err) {
    await container.remove({ force: true, v: true }).catch((removeErr) => {
      console.error("Failed to clean up container after creation error:", removeErr);
    });
    throw err;
  }
}

export async function removeContainer(id: string): Promise<void> {
  await assertManagedContainer(id);
  const container = docker.getContainer(id);
  try {
    await container.stop();
  } catch (err: unknown) {
    const isAlreadyStopped =
      err instanceof Error &&
      (err.message.includes("304") || err.message.includes("is not running"));
    if (!isAlreadyStopped) throw err;
  }
  await container.remove({ v: true });
  cleanupLogWatcher(id);
  healthCache.delete(id);
}

export async function getContainerLogStream(id: string): Promise<NodeJS.ReadableStream> {
  await assertManagedContainer(id);
  const container = docker.getContainer(id);
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 100,
  });
  return demuxDockerStream(stream as unknown as NodeJS.ReadableStream);
}

function cleanupLogWatcher(containerId: string): void {
  const existing = logWatchers.get(containerId);
  if (existing) {
    existing.removeAllListeners();
    if ("destroy" in existing && typeof existing.destroy === "function") {
      existing.destroy();
    }
    logWatchers.delete(containerId);
  }
}

type SSEClient = {
  id: string;
  res: import("express").Response;
};

const sseClients: SSEClient[] = [];

export function addSSEClient(client: SSEClient): void {
  sseClients.push(client);
}

export function removeSSEClient(clientId: string): void {
  const index = sseClients.findIndex((c) => c.id === clientId);
  if (index !== -1) sseClients.splice(index, 1);
}

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const deadClientIds: string[] = [];
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      deadClientIds.push(client.id);
    }
  }
  for (const id of deadClientIds) {
    removeSSEClient(id);
  }
}

async function broadcastUpdate(containerId: string): Promise<void> {
  const container = await getContainer(containerId);
  if (container) {
    broadcastSSE("container-updated", container);
  }
}

export function broadcastRemoval(id: string): void {
  broadcastSSE("container-removed", { id });
}

async function checkClaudeHealth(container: ManagedContainer): Promise<ContainerHealth["claude"]> {
  try {
    const response = await fetch(`http://${container.name}:${CONTAINER_INTERNAL_PORT}/`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });

    return response.status === 200 ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

function pruneStaleCaches(liveIds: Set<string>): void {
  for (const id of healthCache.keys()) {
    if (!liveIds.has(id)) healthCache.delete(id);
  }
  for (const id of [...logWatchers.keys()]) {
    if (!liveIds.has(id)) cleanupLogWatcher(id);
  }
}

export async function runHealthChecks(): Promise<void> {
  const containers = await listContainers();
  pruneStaleCaches(new Set(containers.map((c) => c.id)));

  const results = await Promise.allSettled(
    containers.map(async (managed) => {
      let containerState: ContainerHealth["container"];
      if (managed.status === "running") {
        containerState = "running";
      } else if (managed.status === "exited" || managed.status === "created") {
        containerState = "stopped";
      } else {
        containerState = "error";
      }

      const claudeState: ContainerHealth["claude"] =
        containerState === "running"
          ? await checkClaudeHealth(managed)
          : "unknown";

      const health: ContainerHealth = {
        container: containerState,
        claude: claudeState,
      };

      const prev = healthCache.get(managed.id);
      const changed =
        !prev ||
        prev.container !== health.container ||
        prev.claude !== health.claude;

      healthCache.set(managed.id, health);
      return { id: managed.id, changed };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.changed) {
      await broadcastUpdate(result.value.id);
    }
  }
}

export async function pullLatestImage(): Promise<void> {
  console.log(`Pulling latest image: ${CRC_ENV_IMAGE}`);

  const stream = await docker.pull(CRC_ENV_IMAGE);

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) {
        console.error("Failed to pull image:", err);
        reject(err);
      } else {
        console.log("Image pull complete");
        resolve();
      }
    });
  });
}

export function cleanupAll(): void {
  for (const [id] of logWatchers) {
    cleanupLogWatcher(id);
  }
  for (const client of sseClients) {
    try {
      client.res.end();
    } catch { }
  }
  sseClients.length = 0;
}

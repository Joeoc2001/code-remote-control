import Dockerode from "dockerode";
import crypto from "node:crypto";
import net from "node:net";
import { PassThrough } from "node:stream";
import tar from "tar-stream";
import type {
  ManagedContainer,
  ContainerHealth,
  EnvironmentConfig,
  ConfigFile,
} from "./types.js";
import { GITHUB_TOKEN, GITLAB_TOKEN, CRC_ENV_IMAGE, loadConfigurations } from "./config.js";
import type { RepoSource } from "./types.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export const CONTAINER_INTERNAL_PORT = 8080;
const CONTAINER_PREFIX = "crc-";
const LABEL_CONFIG_NAME = "crc.config-name";
const LABEL_REPO_NAME = "crc.repo-name";
const LABEL_SUBDOMAIN = "crc.subdomain";
const HEALTH_CHECK_TIMEOUT_MS = 1_000;
const OPENCODE_CONFIG_RELATIVE_PATH = "root/.config/opencode/opencode.json";

function createSingleFileTar(filePath: string, content: Buffer, mode: number): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: filePath, mode }, content);
  pack.finalize();

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
    openCode: "unknown" as const,
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
  repoSource: RepoSource = "github"
): Promise<ManagedContainer> {
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
    `GITHUB_TOKEN=${GITHUB_TOKEN}`,
    `GITLAB_TOKEN=${GITLAB_TOKEN}`,
    `GITLAB_URL=${gitlabUrl}`,
    `GIT_USER_NAME=${appConfig.git.username}`,
    `GIT_USER_EMAIL=${appConfig.git.email}`,
    ...Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
  ];

  const container = await docker.createContainer({
    Image: CRC_ENV_IMAGE,
    name: containerName,
    Env: envVars,
    Labels: {
      [LABEL_CONFIG_NAME]: config.name,
      [LABEL_REPO_NAME]: repoFullName,
      [LABEL_SUBDOMAIN]: subdomain,
    },
    HostConfig: {
      AutoRemove: false,
    },
  });

  const configJson = Buffer.from(JSON.stringify(config.opencode));
  const configTar = await createSingleFileTar(OPENCODE_CONFIG_RELATIVE_PATH, configJson, 0o444);
  await container.putArchive(configTar, { path: "/" });

  for (const networkName of appConfig.docker_networks || []) {
    const network = docker.getNetwork(networkName);
    await network.connect({ Container: container.id });
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function checkOpencodeHealth(container: ManagedContainer): Promise<ContainerHealth["openCode"]> {
  try {
    const response = await withTimeout(
      fetch(`http://${container.name}:${CONTAINER_INTERNAL_PORT}/global/health`),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    if (response.status !== 200) return "unhealthy";

    const data = await response.json() as { healthy?: boolean };
    return data.healthy === true ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

export async function runHealthChecks(): Promise<void> {
  const containers = await listContainers();

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

      const opencodeState: ContainerHealth["openCode"] =
        containerState === "running"
          ? await checkOpencodeHealth(managed)
          : "unknown";

      const health: ContainerHealth = {
        container: containerState,
        openCode: opencodeState,
      };

      const prev = healthCache.get(managed.id);
      const changed =
        !prev ||
        prev.container !== health.container ||
        prev.openCode !== health.openCode;

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

export async function pullLatestImageAndPrune(): Promise<void> {
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

  console.log("Pruning dangling images");
  await docker.pruneImages({ filters: { dangling: ["true"] } });
  console.log("Image prune complete");
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

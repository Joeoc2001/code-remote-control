import Dockerode from "dockerode";
import crypto from "node:crypto";
import net from "node:net";
import { PassThrough } from "node:stream";
import tar from "tar-stream";
import type {
  ManagedContainer,
  ContainerHealth,
  EnvironmentConfig,
} from "./types.js";
import { GITHUB_TOKEN, CRC_ENV_IMAGE } from "./config.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

const CONTAINER_PREFIX = "crc-";
const LABEL_CONFIG_NAME = "crc.config-name";
const LABEL_REPO_NAME = "crc.repo-name";
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const OPENCODE_CONFIG_PATH = "/etc/opencode.json";
const CONTAINER_INTERNAL_PORT = 8080;

const MAX_PORT_ATTEMPTS = 10;

function tryBindPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = await tryBindPort();
    const inUse = [...portCache.values()].includes(port);
    if (!inUse) return port;
  }
  throw new Error("Failed to find a free port after " + MAX_PORT_ATTEMPTS + " attempts");
}

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
const portCache = new Map<string, number>();

export function getContainerPort(id: string): number | null {
  return portCache.get(id) ?? null;
}

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

function parseContainerInfo(container: Dockerode.ContainerInfo): ManagedContainer {
  const name = (container.Names[0] || "").replace(/^\//, "");
  const configName = container.Labels[LABEL_CONFIG_NAME] || "unknown";
  const repoName = container.Labels[LABEL_REPO_NAME] || "unknown";
  const status = container.State || "unknown";
  const health = healthCache.get(container.Id) || {
    container: status === "running" ? "running" as const : "stopped" as const,
    openCode: "unknown" as const,
  };

  const portMapping = container.Ports.find(p => p.PrivatePort === CONTAINER_INTERNAL_PORT);
  const hostPort = portMapping?.PublicPort ?? portCache.get(container.Id) ?? 0;
  if (hostPort) portCache.set(container.Id, hostPort);

  return {
    id: container.Id,
    name,
    configName,
    repoName,
    status,
    health,
    hostPort,
    createdAt: new Date(container.Created * 1000).toISOString(),
  };
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

    const configName = info.Config.Labels[LABEL_CONFIG_NAME] || "unknown";
    const repoName = info.Config.Labels[LABEL_REPO_NAME] || "unknown";
    const status = info.State.Running ? "running" : info.State.Status;
    const health = healthCache.get(id) || {
      container: info.State.Running ? "running" as const : "stopped" as const,
      openCode: "unknown" as const,
    };

    const portKey = `${CONTAINER_INTERNAL_PORT}/tcp`;
    const bindings = info.NetworkSettings?.Ports?.[portKey];
    const hostPort = bindings?.[0]?.HostPort ? parseInt(bindings[0].HostPort, 10) : portCache.get(info.Id) ?? 0;
    if (hostPort) portCache.set(info.Id, hostPort);

    return {
      id: info.Id,
      name,
      configName,
      repoName,
      status,
      health,
      hostPort,
      createdAt: info.Created,
    };
  } catch {
    return null;
  }
}

export async function createContainer(
  config: EnvironmentConfig,
  repoFullName: string
): Promise<ManagedContainer> {
  const repoShortName = slugify(repoFullName.split("/").pop() || "repo");
  const containerName = `${CONTAINER_PREFIX}${slugify(config.name)}-${repoShortName}-${generateId()}`;
  const repoUrl = `https://github.com/${repoFullName}.git`;
  const hostPort = await findFreePort();

  const envVars = [
    `REPO_URL=${repoUrl}`,
    `GITHUB_TOKEN=${GITHUB_TOKEN}`,
    `OPENCODE_CONFIG=${OPENCODE_CONFIG_PATH}`,
    ...Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
  ];

  const portKey = `${CONTAINER_INTERNAL_PORT}/tcp`;

  const container = await docker.createContainer({
    Image: CRC_ENV_IMAGE,
    name: containerName,
    Env: envVars,
    Labels: {
      [LABEL_CONFIG_NAME]: config.name,
      [LABEL_REPO_NAME]: repoFullName,
    },
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      AutoRemove: false,
      PortBindings: {
        [portKey]: [{ HostPort: String(hostPort) }],
      },
    },
  });

  const configJson = Buffer.from(JSON.stringify(config.opencode));
  const configTar = await createSingleFileTar("etc/opencode.json", configJson, 0o444);
  await container.putArchive(configTar, { path: "/" });

  await container.start();

  portCache.set(container.id, hostPort);

  const info = await container.inspect();
  return {
    id: info.Id,
    name: containerName,
    configName: config.name,
    repoName: repoFullName,
    status: "running",
    health: { container: "running", openCode: "unknown" },
    hostPort,
    createdAt: info.Created,
  };
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
  portCache.delete(id);
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

async function checkOpencodeHealth(containerId: string): Promise<ContainerHealth["openCode"]> {
  try {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ["pgrep", "-f", "opencode.*--remote"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const execStream = await exec.start({ Detach: false });
    const output = await withTimeout(
      new Promise<string>((resolve) => {
        let data = "";
        (execStream as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        (execStream as unknown as NodeJS.ReadableStream).on("end", () => resolve(data));
        (execStream as unknown as NodeJS.ReadableStream).on("error", () => resolve(""));
      }),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    return output.trim().length > 0 ? "healthy" : "unhealthy";
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
          ? await checkOpencodeHealth(managed.id)
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

export async function updateAndRestartSystem(): Promise<void> {
  const IMAGE_1 = "ghcr.io/joeoc2001/code-remote-control:latest";
  const IMAGE_2 = "ghcr.io/joeoc2001/code-remote-control-env:latest";
  const CONTAINER_NAME = "code-remote-control";

  async function pullImage(imageName: string): Promise<void> {
    console.log(`Pulling image: ${imageName}`);
    const stream = await docker.pull(imageName);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, _output) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
    console.log(`Successfully pulled: ${imageName}`);
  }

  async function pruneOldImages(imageRepo: string): Promise<void> {
    console.log(`Pruning old versions of: ${imageRepo}`);
    const images = await docker.listImages();
    const repoPrefix = imageRepo.split(":")[0];

    for (const image of images) {
      if (!image.RepoTags) continue;
      for (const tag of image.RepoTags) {
        if (tag.startsWith(repoPrefix) && tag !== imageRepo) {
          try {
            console.log(`Removing old image: ${tag}`);
            await docker.getImage(tag).remove({ force: false });
          } catch (err) {
            console.warn(`Failed to remove image ${tag}:`, err);
          }
        }
      }
    }
  }

  async function restartSelfContainer(): Promise<void> {
    console.log(`Finding container: ${CONTAINER_NAME}`);
    const containers = await docker.listContainers({ all: true });
    const selfContainer = containers.find((c) =>
      c.Names.some((name) => name === `/${CONTAINER_NAME}` || name === CONTAINER_NAME)
    );

    if (!selfContainer) {
      throw new Error(`Container ${CONTAINER_NAME} not found`);
    }

    const container = docker.getContainer(selfContainer.Id);
    const info = await container.inspect();

    const volumeArgs = (info.HostConfig.Binds || []).map(b => `--volume "${b}"`).join(" ");
    const portArgs = Object.entries(info.HostConfig.PortBindings || {})
      .flatMap(([internal, bindings]) => {
        if (!Array.isArray(bindings)) return [];
        return bindings.map((b) => `-p ${b.HostPort}:${internal.replace("/tcp", "")}`);
      })
      .join(" ");
    const envArgs = (info.Config.Env || []).map(e => `--env "${e}"`).join(" ");
    const labelArgs = Object.entries(info.Config.Labels || {})
      .map(([k, v]) => `--label "${k}=${v}"`)
      .join(" ");
    const networkArgs = info.HostConfig.NetworkMode ? `--network ${info.HostConfig.NetworkMode}` : "";
    const restartPolicy = info.HostConfig.RestartPolicy?.Name ? `--restart ${info.HostConfig.RestartPolicy.Name}` : "";
    const workdirArg = info.Config.WorkingDir ? `--workdir "${info.Config.WorkingDir}"` : "";
    const userArg = info.Config.User ? `--user "${info.Config.User}"` : "";
    const hostnameArg = info.Config.Hostname ? `--hostname "${info.Config.Hostname}"` : "";
    const privilegedArg = info.HostConfig.Privileged ? "--privileged" : "";
    const capAddArgs = (info.HostConfig.CapAdd || []).map((cap: string) => `--cap-add ${cap}`).join(" ");
    const capDropArgs = (info.HostConfig.CapDrop || []).map((cap: string) => `--cap-drop ${cap}`).join(" ");

    console.log(`Creating restart script container`);
    const restartScript = `
      sleep 3
      echo "Stopping old container..."
      docker stop ${selfContainer.Id}
      echo "Removing old container..."
      docker rm ${selfContainer.Id}
      echo "Creating new container..."
      docker run -d \\
        --name ${CONTAINER_NAME} \\
        ${volumeArgs} \\
        ${portArgs} \\
        ${envArgs} \\
        ${labelArgs} \\
        ${networkArgs} \\
        ${restartPolicy} \\
        ${workdirArg} \\
        ${userArg} \\
        ${hostnameArg} \\
        ${privilegedArg} \\
        ${capAddArgs} \\
        ${capDropArgs} \\
        ${IMAGE_1}
      echo "Restart complete"
    `.trim();

    await docker.run(
      "alpine:latest",
      ["sh", "-c", restartScript],
      process.stdout,
      {
        HostConfig: {
          AutoRemove: true,
          Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        },
      }
    );

    console.log("Restart script initiated");
  }

  setTimeout(async () => {
    try {
      await pullImage(IMAGE_1);
      await pullImage(IMAGE_2);
      await pruneOldImages(IMAGE_1);
      await pruneOldImages(IMAGE_2);
      await restartSelfContainer();
    } catch (err) {
      console.error("Update and restart failed:", err);
    }
  }, 1000);
}

import type { ManagedContainer } from "@crc/shared";

export function makeContainer(id: string, createdAt: string, status = "running"): ManagedContainer {
  return {
    id,
    name: `crc-${id}`,
    configName: "default",
    agent: "claude",
    repoName: "example/repo",
    status,
    health: { container: status === "running" ? "running" : "stopped", agent: "unknown" },
    subdomain: id,
    createdAt,
  };
}

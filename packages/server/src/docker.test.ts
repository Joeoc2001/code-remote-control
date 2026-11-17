import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHostConfig } from "./docker.js";

describe("buildHostConfig mounts", () => {
  it("leaves Mounts unset when no mounts are configured", () => {
    assert.equal(buildHostConfig(undefined).Mounts, undefined);
    assert.equal(buildHostConfig({ binds: ["/a:/b"] }).Mounts, undefined);
  });

  it("maps a named volume with driver options", () => {
    const hostConfig = buildHostConfig({
      mounts: [
        {
          type: "volume",
          source: "claude-npm-cache",
          target: "/root/.npm",
          volume_options: {
            no_copy: true,
            labels: { owner: "crc" },
            driver_config: { name: "local", options: { type: "nfs", o: "addr=10.0.0.1", device: ":/cache" } },
          },
        },
      ],
    });
    assert.deepEqual(hostConfig.Mounts, [
      {
        Type: "volume",
        Source: "claude-npm-cache",
        Target: "/root/.npm",
        ReadOnly: undefined,
        Consistency: undefined,
        BindOptions: undefined,
        VolumeOptions: {
          NoCopy: true,
          Labels: { owner: "crc" },
          DriverConfig: { Name: "local", Options: { type: "nfs", o: "addr=10.0.0.1", device: ":/cache" } },
        },
        TmpfsOptions: undefined,
      },
    ]);
  });

  it("fills omitted volume option fields with Docker's zero-value defaults", () => {
    const [mount] = buildHostConfig({
      mounts: [{ type: "volume", target: "/cache", volume_options: { driver_config: { name: "local" } } }],
    }).Mounts!;
    assert.equal(mount.Source, "");
    assert.deepEqual(mount.VolumeOptions, { NoCopy: false, Labels: {}, DriverConfig: { Name: "local", Options: {} } });
  });

  it("maps a read-only bind with propagation", () => {
    const hostConfig = buildHostConfig({
      mounts: [
        {
          type: "bind",
          source: "/srv/data",
          target: "/data",
          read_only: true,
          consistency: "cached",
          bind_options: { propagation: "rslave" },
        },
      ],
    });
    assert.deepEqual(hostConfig.Mounts, [
      {
        Type: "bind",
        Source: "/srv/data",
        Target: "/data",
        ReadOnly: true,
        Consistency: "cached",
        BindOptions: { Propagation: "rslave" },
        VolumeOptions: undefined,
        TmpfsOptions: undefined,
      },
    ]);
  });

  it("maps a tmpfs mount with size and mode", () => {
    const hostConfig = buildHostConfig({
      mounts: [{ type: "tmpfs", target: "/scratch", tmpfs_options: { size_bytes: 1073741824, mode: 0o1777 } }],
    });
    assert.deepEqual(hostConfig.Mounts, [
      {
        Type: "tmpfs",
        Source: "",
        Target: "/scratch",
        ReadOnly: undefined,
        Consistency: undefined,
        BindOptions: undefined,
        VolumeOptions: undefined,
        TmpfsOptions: { SizeBytes: 1073741824, Mode: 0o1777 },
      },
    ]);
  });

  it("keeps binds and mounts side by side in order", () => {
    const hostConfig = buildHostConfig({
      binds: ["/srv/cache/claude:/workspace/.cache"],
      mounts: [
        { type: "tmpfs", target: "/a" },
        { type: "volume", source: "v", target: "/b" },
      ],
    });
    assert.deepEqual(hostConfig.Binds, ["/srv/cache/claude:/workspace/.cache"]);
    assert.deepEqual(hostConfig.Mounts!.map((mount) => mount.Target), ["/a", "/b"]);
  });
});

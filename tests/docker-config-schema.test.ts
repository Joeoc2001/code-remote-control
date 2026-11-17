import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { configFileSchema, resolveConfigFile } from "@crc/shared";

const baseConfigFile = {
  root_domain: "example.com",
  git: { email: "bot@example.com", username: "bot" },
  oauth: { accessToken: "token" },
  configurations: [{ name: "default" }],
};

function parseWithDocker(dockerBlock: unknown, placement: "top-level" | "configuration") {
  const file =
    placement === "top-level"
      ? { ...baseConfigFile, docker: dockerBlock }
      : { ...baseConfigFile, configurations: [{ name: "default", docker: dockerBlock }] };
  return configFileSchema.parse(file);
}

describe("docker.auto_remove", () => {
  test("is accepted when absent", () => {
    assert.doesNotThrow(() => parseWithDocker({ restart_policy: { name: "unless-stopped" } }, "configuration"));
  });

  test("is accepted when explicitly disabled", () => {
    assert.doesNotThrow(() => parseWithDocker({ auto_remove: false }, "configuration"));
  });

  test("is rejected on a configuration because it prevents resuming after a restart", () => {
    assert.throws(
      () => parseWithDocker({ auto_remove: true }, "configuration"),
      /auto_remove must not be enabled/,
    );
  });

  test("is rejected on the top-level defaults block", () => {
    assert.throws(
      () => parseWithDocker({ auto_remove: true }, "top-level"),
      /auto_remove must not be enabled/,
    );
  });

  test("explains that transcripts are lost", () => {
    assert.throws(() => parseWithDocker({ auto_remove: true }, "configuration"), /resume/);
  });
});

describe("docker.mounts", () => {
  test("accepts bind, volume and tmpfs mounts with their own options", () => {
    const parsed = parseWithDocker(
      {
        mounts: [
          { type: "bind", source: "/srv/data", target: "/data", read_only: true, bind_options: { propagation: "rslave" } },
          { type: "volume", source: "claude-npm-cache", target: "/root/.npm" },
          {
            type: "volume",
            target: "/anon",
            volume_options: { no_copy: true, driver_config: { name: "local", options: { type: "tmpfs" } } },
          },
          { type: "tmpfs", target: "/scratch", tmpfs_options: { size_bytes: 1024, mode: 0o1777 } },
        ],
      },
      "configuration",
    );
    assert.equal(parsed.configurations[0].docker?.mounts?.length, 4);
  });

  test("is accepted on the top-level defaults block", () => {
    assert.doesNotThrow(() => parseWithDocker({ mounts: [{ type: "tmpfs", target: "/scratch" }] }, "top-level"));
  });

  test("rejects a bind mount without a source", () => {
    assert.throws(
      () => parseWithDocker({ mounts: [{ type: "bind", target: "/data" }] }, "configuration"),
      /bind mount requires a source/,
    );
  });

  test("rejects a tmpfs mount with a source", () => {
    assert.throws(
      () => parseWithDocker({ mounts: [{ type: "tmpfs", source: "x", target: "/scratch" }] }, "configuration"),
      /tmpfs mount must not have a source/,
    );
  });

  for (const [key, options, wrongType] of [
    ["tmpfs_options", { size_bytes: 1024 }, "volume"],
    ["volume_options", { driver_config: { name: "local" } }, "bind"],
    ["bind_options", { propagation: "rprivate" }, "volume"],
  ] as const) {
    test(`rejects ${key} on a ${wrongType} mount`, () => {
      assert.throws(
        () =>
          parseWithDocker(
            { mounts: [{ type: wrongType, source: "/x", target: "/y", [key]: options }] },
            "configuration",
          ),
        new RegExp(`${key} is only allowed on a`),
      );
    });
  }

  test("rejects a tmpfs mode of 0", () => {
    assert.throws(() =>
      parseWithDocker({ mounts: [{ type: "tmpfs", target: "/scratch", tmpfs_options: { mode: 0 } }] }, "configuration"),
    );
  });

  test("rejects an unknown mount type", () => {
    assert.throws(() => parseWithDocker({ mounts: [{ type: "image", source: "x", target: "/y" }] }, "configuration"));
  });

  test("rejects a mount without a target", () => {
    assert.throws(() => parseWithDocker({ mounts: [{ type: "volume", source: "v" }] }, "configuration"));
  });

  test("accepts volume_options without a driver_config", () => {
    assert.doesNotThrow(() =>
      parseWithDocker({ mounts: [{ type: "volume", target: "/y", volume_options: { no_copy: true } }] }, "configuration"),
    );
  });

  test("rejects a driver_config without a name", () => {
    assert.throws(() =>
      parseWithDocker(
        { mounts: [{ type: "volume", target: "/y", volume_options: { driver_config: { options: { type: "tmpfs" } } } }] },
        "configuration",
      ),
    );
  });

  test("rejects bind_options without a propagation", () => {
    assert.throws(() =>
      parseWithDocker({ mounts: [{ type: "bind", source: "/x", target: "/y", bind_options: {} }] }, "configuration"),
    );
  });

  test("a configuration's mounts replace the top-level default mounts", () => {
    const file = configFileSchema.parse({
      ...baseConfigFile,
      docker: { mounts: [{ type: "tmpfs", target: "/default" }] },
      configurations: [{ name: "default", docker: { mounts: [{ type: "tmpfs", target: "/override" }] } }],
    });
    const [resolved] = resolveConfigFile(file).configurations;
    assert.deepEqual(resolved.docker?.mounts?.map((mount) => mount.target), ["/override"]);
  });
});

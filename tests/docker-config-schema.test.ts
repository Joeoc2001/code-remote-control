import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { configFileSchema } from "@crc/shared";

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

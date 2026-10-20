import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createQuickPromptsRouter } from "./quick-prompt-routes.js";
import { QuickPromptStore } from "./quick-prompt-store.js";
import type { QuickPrompt } from "../types.js";

describe("quick-prompt routes", () => {
  let server: Server;
  let origin: string;
  let store: QuickPromptStore;

  before(async () => {
    store = new QuickPromptStore(mkdtempSync(join(tmpdir(), "crc-quick-prompt-routes-")));
    const app = express();
    app.use(express.json());
    app.use(createQuickPromptsRouter(store));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function query(repoSource: string, repoFullName: string): string {
    return new URLSearchParams({ repoSource, repoFullName }).toString();
  }

  function list(repoSource: string, repoFullName: string): Promise<Response> {
    return fetch(`${origin}/api/quick-prompts?${query(repoSource, repoFullName)}`);
  }

  function create(body: unknown): Promise<Response> {
    return fetch(`${origin}/api/quick-prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function remove(id: string, repoSource: string, repoFullName: string): Promise<Response> {
    return fetch(`${origin}/api/quick-prompts/${encodeURIComponent(id)}?${query(repoSource, repoFullName)}`, {
      method: "DELETE",
    });
  }

  it("creates, lists and deletes quick-prompts for a repository", async () => {
    const created = await create({ repoSource: "github", repoFullName: "owner/routes", text: "  Bump deps \n" });
    assert.equal(created.status, 201);
    const prompt = (await created.json()) as QuickPrompt;
    assert.equal(prompt.text, "Bump deps");

    const listed = await list("github", "owner/routes");
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), [prompt]);
    assert.deepEqual(await (await list("gitlab", "owner/routes")).json(), []);

    const deleted = await remove(prompt.id, "github", "owner/routes");
    assert.equal(deleted.status, 204);
    assert.deepEqual(await (await list("github", "owner/routes")).json(), []);
  });

  it("rejects duplicate text for the same repository with 409 but allows it elsewhere", async () => {
    assert.equal((await create({ repoSource: "github", repoFullName: "owner/dupes", text: "Same" })).status, 201);

    const duplicate = await create({ repoSource: "github", repoFullName: "owner/dupes", text: " Same " });
    assert.equal(duplicate.status, 409);
    assert.match(((await duplicate.json()) as { error: string }).error, /already exists/);

    assert.equal((await create({ repoSource: "gitlab", repoFullName: "owner/dupes", text: "Same" })).status, 201);
    assert.equal(store.list("github", "owner/dupes").length, 1);
  });

  it("rejects empty or missing text", async () => {
    for (const text of ["", "   \n", undefined, 42]) {
      const res = await create({ repoSource: "github", repoFullName: "owner/empty", text });
      assert.equal(res.status, 400, `text ${JSON.stringify(text)}`);
    }
    assert.deepEqual(store.list("github", "owner/empty"), []);
  });

  it("validates the repository on every endpoint", async () => {
    const cases = [
      { repoSource: "bitbucket", repoFullName: "owner/repo", error: /repoSource must be/ },
      { repoSource: "github", repoFullName: "not-a-repo", error: /owner\/repo format/ },
      { repoSource: "github", repoFullName: "", error: /repoFullName is required/ },
    ];
    for (const { repoSource, repoFullName, error } of cases) {
      for (const res of [
        await list(repoSource, repoFullName),
        await create({ repoSource, repoFullName, text: "Prompt" }),
        await remove("some-id", repoSource, repoFullName),
      ]) {
        assert.equal(res.status, 400, `${res.url} ${repoSource}:${repoFullName}`);
        assert.match(((await res.json()) as { error: string }).error, error);
      }
    }
  });

  it("returns 404 when deleting an unknown quick-prompt or one from another repository", async () => {
    const prompt = store.add("github", "owner/missing", "Prompt");
    assert.equal((await remove("unknown", "github", "owner/missing")).status, 404);
    assert.equal((await remove(prompt.id, "gitlab", "owner/missing")).status, 404);
    assert.deepEqual(store.list("github", "owner/missing"), [prompt]);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { InstanceState, InstanceStatus, ManagedContainer } from "../packages/client/src/types.js";
import { sortContainers } from "../packages/client/src/components/containerOrder.js";
import { makeContainer } from "./helpers/container-fixture.js";

const ids = (containers: { id: string }[]) => containers.map((container) => container.id);

function statusLookup(states: Record<string, InstanceState | null>) {
  return (container: ManagedContainer): InstanceStatus | null => {
    const state = states[container.id];
    return state ? { state, updatedAt: null, lastActivityAt: null } : null;
  };
}

describe("sortContainers", () => {
  test("puts waiting containers first, then finished, then busy, then those without a status", () => {
    const states: Record<string, InstanceState | null> = {
      none: null,
      working: "working",
      finished: "finished",
      "awaiting-background": "awaiting-background",
      waiting: "waiting",
    };
    const containers = Object.keys(states).map((id) => makeContainer(id, "2026-01-01T00:00:00.000Z"));

    const sorted = sortContainers(containers, statusLookup(states));

    assert.deepEqual(ids(sorted.slice(0, 2)), ["waiting", "finished"]);
    assert.deepEqual(new Set(ids(sorted.slice(2, 4))), new Set(["working", "awaiting-background"]));
    assert.deepEqual(ids(sorted.slice(4)), ["none"]);
  });

  test("orders containers within each group newest first", () => {
    const containers = [
      makeContainer("old-working", "2026-01-01T00:00:00.000Z"),
      makeContainer("old-none", "2026-01-01T00:00:00.000Z"),
      makeContainer("new-waiting", "2026-01-03T00:00:00.000Z"),
      makeContainer("old-waiting", "2026-01-01T00:00:00.000Z"),
      makeContainer("new-none", "2026-01-03T00:00:00.000Z"),
      makeContainer("mid-background", "2026-01-02T00:00:00.000Z"),
      makeContainer("old-finished", "2026-01-01T00:00:00.000Z"),
      makeContainer("new-finished", "2026-01-03T00:00:00.000Z"),
    ];
    const states: Record<string, InstanceState | null> = {
      "old-working": "working",
      "old-none": null,
      "new-waiting": "waiting",
      "old-waiting": "waiting",
      "new-none": null,
      "mid-background": "awaiting-background",
      "old-finished": "finished",
      "new-finished": "finished",
    };

    assert.deepEqual(ids(sortContainers(containers, statusLookup(states))), [
      "new-waiting",
      "old-waiting",
      "new-finished",
      "old-finished",
      "mid-background",
      "old-working",
      "new-none",
      "old-none",
    ]);
  });

  test("sorts containers with no status last even when they are newest", () => {
    const containers = [
      makeContainer("stopped", "2026-01-09T00:00:00.000Z", "exited"),
      makeContainer("working", "2026-01-01T00:00:00.000Z"),
    ];

    assert.deepEqual(ids(sortContainers(containers, statusLookup({ working: "working" }))), ["working", "stopped"]);
  });

  test("does not mutate its input", () => {
    const containers = [
      makeContainer("working", "2026-01-01T00:00:00.000Z"),
      makeContainer("waiting", "2026-01-01T00:00:00.000Z"),
    ];

    sortContainers(containers, statusLookup({ working: "working", waiting: "waiting" }));

    assert.deepEqual(ids(containers), ["working", "waiting"]);
  });
});

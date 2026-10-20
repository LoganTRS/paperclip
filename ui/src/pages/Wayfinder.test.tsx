import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildMapGraph, isWayfindingMap } from "./Wayfinder";

function issue(partial: Partial<Issue> & { id: string; title: string }): Issue {
  return {
    companyId: "company-1",
    parentId: null,
    status: "todo",
    identifier: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    workMode: "auto",
    priority: "medium",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...partial,
  } as unknown as Issue;
}

function mapIssue(): Issue {
  return issue({
    id: "map",
    title: "Golf game: wayfinding map",
    description: "## Destination\nA spec for the game.",
    labels: [
      {
        id: "l",
        companyId: "company-1",
        name: "wayfinder:map",
        color: "currentColor",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
}

const done = (id: string, title: string, opts: Partial<Issue> = {}) =>
  issue({ id, title, status: "done", ...opts });
const open = (id: string, title: string, opts: Partial<Issue> = {}) =>
  issue({ id, title, status: "todo", ...opts });

describe("isWayfindingMap", () => {
  it("matches the wayfinder:map label (case-insensitive)", () => {
    expect(
      isWayfindingMap(
        issue({
          id: "a",
          title: "Map",
          labels: [{ id: "l", companyId: "company-1", name: "Wayfinder:Map", color: "currentColor", createdAt: new Date(), updatedAt: new Date() }],
        }),
      ),
    ).toBe(true);
  });

  it("does NOT match a title ending in 'wayfinding map' without the label", () => {
    expect(isWayfindingMap(issue({ id: "a", title: "Golf game: wayfinding map" }))).toBe(false);
  });

  it("does NOT match a body carrying '## Destination' without the label", () => {
    expect(
      isWayfindingMap(issue({ id: "a", title: "Spec", description: "## Destination\nx" })),
    ).toBe(false);
  });

  it("does not match a plain ticket", () => {
    expect(isWayfindingMap(issue({ id: "a", title: "Pick a physics engine" }))).toBe(false);
  });

  it("ignores hidden issues even when labelled", () => {
    expect(
      isWayfindingMap(
        issue({
          id: "a",
          title: "Golf: wayfinding map",
          hiddenAt: new Date(),
          labels: [{ id: "l", companyId: "company-1", name: "wayfinder:map", color: "currentColor", createdAt: new Date(), updatedAt: new Date() }],
        }),
      ),
    ).toBe(false);
  });
});

describe("buildMapGraph", () => {
  it("computes the frontier from blockedBy statuses", () => {
    const map = mapIssue();
    const a = open("a", "A", { parentId: "map", identifier: "TEC-1" });
    const b = open(
      "b",
      "B",
      {
        parentId: "map",
        identifier: "TEC-2",
        blockedBy: [{ id: "a", identifier: "TEC-1", title: "A", status: "done", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      },
    );
    const c = open(
      "c",
      "C",
      {
        parentId: "map",
        identifier: "TEC-3",
        blockedBy: [{ id: "b", identifier: "TEC-2", title: "B", status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      },
    );
    // B's blocker (A) is listed as done in the projection even though A's own
    // row is open here — the graph trusts the projection. Make A done to be
    // consistent:
    const aDone = { ...a, status: "done" } as Issue;
    const graph = buildMapGraph(map, [map, aDone, b, c]);
    expect(graph.frontier.map((t) => t.id)).toEqual(["b"]);
    expect(graph.openCount).toBe(2);
  });

  it("puts a done blocker's edge in and excludes done tickets from the frontier", () => {
    const map = mapIssue();
    const a = done("a", "A", { parentId: "map", identifier: "TEC-1" });
    const b = open(
      "b",
      "B",
      {
        parentId: "map",
        identifier: "TEC-2",
        blockedBy: [{ id: "a", identifier: "TEC-1", title: "A", status: "done", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      },
    );
    const graph = buildMapGraph(map, [map, a, b]);
    expect(graph.frontier.map((t) => t.id)).toEqual(["b"]);
    expect(graph.edges).toEqual([{ fromId: "a", toId: "b" }]);
  });

  it("treats a map with all-done children as clear", () => {
    const map = mapIssue();
    const a = done("a", "A", { parentId: "map", identifier: "TEC-1" });
    const b = done(
      "b",
      "B",
      {
        parentId: "map",
        identifier: "TEC-2",
        blockedBy: [{ id: "a", identifier: "TEC-1", title: "A", status: "done", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      },
    );
    const graph = buildMapGraph(map, [map, a, b]);
    expect(graph.frontier).toEqual([]);
    expect(graph.openCount).toBe(0);
  });

  it("waits on an out-of-map blocker that is actually open (fail-closed)", () => {
    const map = mapIssue();
    // Blocker d is NOT a child of the map (e.g. a spec ticket elsewhere). The
    // ticket's readiness check must still wait on it: the projection says it
    // is open, so the ticket is not attackable.
    const d = open("d", "External spec", { identifier: "EXT-1" });
    const a = open(
      "a",
      "A",
      {
        parentId: "map",
        identifier: "TEC-1",
        blockedBy: [{ id: "d", identifier: "EXT-1", title: "External", status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      },
    );
    const graph = buildMapGraph(map, [map, d, a]);
    expect(graph.frontier).toEqual([]);
    expect(graph.edges).toEqual([{ fromId: "d", toId: "a" }]);
  });

  it("treats an out-of-map blocker as resolved when the projection says done", () => {
    const map = mapIssue();
    const d = done("d", "External spec", { identifier: "EXT-1" });
    const a = open(
      "a",
      "A",
      {
        parentId: "map",
        identifier: "TEC-1",
        blockedBy: [{ id: "d", identifier: "EXT-1", title: "External", status: "done", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      },
    );
    const graph = buildMapGraph(map, [map, d, a]);
    expect(graph.frontier.map((t) => t.id)).toEqual(["a"]);
  });
});

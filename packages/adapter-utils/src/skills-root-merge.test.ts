import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPaperclipSkillEntries, resolvePaperclipSkillsDir } from "./server-utils.js";

const dirs: string[] = [];

async function makeSkillDir(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `# ${name}\n`);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("listPaperclipSkillEntries (skills-root merge)", () => {
  it("merges every existing candidate root instead of stopping at the first", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "pc-skills-"));
    dirs.push(base);

    // Mirror the real layout depth: the repo root is 5 levels above the
    // adapter's dist/server dir (dist -> hermes -> adapters -> packages -> app).
    //   ../../skills            => <root>/packages/adapters/hermes/skills
    //   ../../../../../skills    => <root>/skills
    const root = path.join(base, "app");
    const moduleDir = path.join(root, "packages", "adapters", "hermes", "dist", "server");
    await mkdir(moduleDir, { recursive: true });

    // Candidate 1: ../../skills  -> <root>/packages/adapters/hermes/skills (sparse shadow)
    const shadowRoot = path.join(root, "packages", "adapters", "hermes", "skills");
    await makeSkillDir(shadowRoot, "paperclip-task-bridge");

    // Candidate 2: ../../../../../skills -> <root>/skills (canonical, the rest)
    const canonicalRoot = path.join(root, "skills");
    await makeSkillDir(canonicalRoot, "complain");
    await makeSkillDir(canonicalRoot, "paperclip");
    await makeSkillDir(canonicalRoot, "suggestion-box");

    const entries = await listPaperclipSkillEntries(moduleDir);
    const byName = new Map(entries.map((entry) => [entry.runtimeName, entry]));

    // The shadow dir must NOT hide the canonical dir: skills from BOTH roots are
    // discoverable.
    expect(byName.has("paperclip-task-bridge")).toBe(true);
    expect(byName.has("complain")).toBe(true);
    expect(byName.has("paperclip")).toBe(true);
    expect(byName.has("suggestion-box")).toBe(true);

    // Each entry's source points at the root that actually contains it.
    expect(byName.get("complain")?.source).toBe(path.join(canonicalRoot, "complain"));
    expect(byName.get("paperclip-task-bridge")?.source).toBe(
      path.join(shadowRoot, "paperclip-task-bridge"),
    );
  });

  it("prefers the closest root's copy on a name conflict (first candidate wins)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "pc-skills-"));
    dirs.push(base);

    const root = path.join(base, "app");
    const moduleDir = path.join(root, "packages", "adapters", "hermes", "dist", "server");
    await mkdir(moduleDir, { recursive: true });

    const shadowRoot = path.join(root, "packages", "adapters", "hermes", "skills");
    await makeSkillDir(shadowRoot, "duplicated");

    const canonicalRoot = path.join(root, "skills");
    await makeSkillDir(canonicalRoot, "duplicated");

    const entries = await listPaperclipSkillEntries(moduleDir);
    const match = entries.find((entry) => entry.runtimeName === "duplicated");
    // Exactly one entry for the name, and it resolves from the closer (first) root.
    expect(entries.filter((entry) => entry.runtimeName === "duplicated")).toHaveLength(1);
    expect(match?.source).toBe(path.join(shadowRoot, "duplicated"));
  });

  it("returns [] when no candidate root exists", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "pc-skills-"));
    dirs.push(base);
    const moduleDir = path.join(base, "adapters", "hermes", "dist", "server");
    await mkdir(moduleDir, { recursive: true });
    const entries = await listPaperclipSkillEntries(moduleDir);
    expect(entries).toEqual([]);
  });
});

describe("resolvePaperclipSkillsDir (still first-existing-root for single-root consumers)", () => {
  it("resolves the first existing candidate root", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "pc-skills-resolve-"));
    dirs.push(base);
    const root = path.join(base, "app");
    const moduleDir = path.join(root, "packages", "adapters", "hermes", "dist", "server");
    await mkdir(moduleDir, { recursive: true });
    const shadowRoot = path.join(root, "packages", "adapters", "hermes", "skills");
    await mkdir(shadowRoot, { recursive: true });
    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(shadowRoot);
  });
});

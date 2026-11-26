import { expect, test } from "bun:test";

import type { Db } from "@texfolia/db";
import { projectGit, projectNode } from "@texfolia/db/schema";

import type { LockProject } from "#/lib/projects/server";
import type { SourceBucket } from "#/lib/storage/server";

import { gitVersion, runGit } from "./actions";
import { GitRepository } from "./repository";
import {
  archiveBody,
  legacyArchive,
  memoryFiles,
  provideFixedLengthStream,
} from "./testing";

provideFixedLengthStream();

const projectId = "11111111-1111-4111-8111-111111111111";
const rootId = "22222222-2222-4222-8222-222222222222";
const mainId = "33333333-3333-4333-8333-333333333333";
const user = { id: "user-1", name: "Author", email: "author@example.com" };
const remoteUrl = "https://github.com/owner/paper.git";
const bytes = (value: string) => new TextEncoder().encode(value);

type LinkedRow = typeof projectGit.$inferSelect;
type NodeRow = typeof projectNode.$inferSelect;

function makeNode(
  overrides: Partial<NodeRow> & Pick<NodeRow, "id" | "name" | "kind">,
): NodeRow {
  return {
    projectId,
    parentId: null,
    objectKey: null,
    sizeBytes: 0n,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    deletedAt: null,
    ...overrides,
  };
}

function createHarness({
  initialLinked,
  initialNodes,
  objects,
  onBucketGet,
}: {
  initialLinked: LinkedRow | undefined;
  initialNodes: NodeRow[];
  objects: Map<string, Uint8Array | string>;
  onBucketGet?: (key: string, lockHeld: boolean) => void;
}) {
  let linked = initialLinked;
  let nodes = initialNodes;
  let lockHeld = false;
  const lockedReads: string[] = [];
  const reads: string[] = [];

  function makeTx() {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === projectGit) return linked ? [linked] : [];
            if (table === projectNode) return nodes;
            return [];
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: async () => {
          if (table === projectGit) linked = undefined;
        },
      }),
      insert: (table: unknown) => ({
        values: () => ({
          onConflictDoUpdate: async ({ set }: { set: Partial<LinkedRow> }) => {
            if (table === projectGit)
              linked = {
                projectId,
                provider: set.provider ?? null,
                url: set.url ?? null,
                objectKey: set.objectKey ?? "",
                branch: set.branch ?? null,
              };
          },
          onConflictDoNothing: async () => {},
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Partial<LinkedRow>) => ({
          where: async () => {
            if (table === projectGit && linked && "branch" in values)
              linked = { ...linked, branch: values.branch ?? null };
          },
        }),
      }),
    };
  }

  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      lockHeld = true;
      try {
        return await fn(makeTx());
      } finally {
        lockHeld = false;
      }
    },
    update: (table: unknown) => ({
      set: (values: Partial<LinkedRow>) => ({
        where: async () => {
          if (table === projectGit && linked && "branch" in values)
            linked = { ...linked, branch: values.branch ?? null };
        },
      }),
    }),
  } as unknown as Db;

  const lock: LockProject = async () => ({
    id: projectId,
    ownerId: user.id,
    organizationId: null,
    name: "Paper",
    formatIndent: 2,
    formatWrap: true,
    formatWidth: 80,
    spellcheckLanguage: "en-US",
    mainFile: null,
    organizationRole: null,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    deletedAt: null,
    role: "editor",
    canWrite: true,
    canComment: true,
    guest: false,
  });

  const bucket: SourceBucket = {
    async get(key: string) {
      reads.push(key);
      if (lockHeld) lockedReads.push(key);
      onBucketGet?.(key, lockHeld);
      const stored = objects.get(key);
      if (stored === undefined) return null;
      const data = typeof stored === "string" ? bytes(stored) : stored;
      return {
        text: async () => new TextDecoder().decode(data),
        arrayBuffer: async () => data.slice().buffer,
        body: archiveBody(data),
      } as unknown as R2ObjectBody;
    },
    async put(key: string, value: unknown) {
      if (typeof value === "string") objects.set(key, value);
      else if (value instanceof Uint8Array) objects.set(key, value);
      else if (value instanceof ReadableStream)
        objects.set(key, await new Response(value).bytes());
      return {} as R2Object;
    },
    async list() {
      return { objects: [], truncated: false } as unknown as R2Objects;
    },
    async delete() {},
  };

  return {
    db,
    lock,
    bucket,
    reads,
    lockedReads,
    getLinked: () => linked,
    setLinked: (next: LinkedRow | undefined) => {
      linked = next;
    },
    setNodes: (next: NodeRow[]) => {
      nodes = next;
    },
    tx: makeTx,
  };
}

async function seedRepo(content: string) {
  const repo = new GitRepository();
  await repo.init(remoteUrl);
  repo.overlay(memoryFiles({ "main.tex": content }));
  await repo.commit("Initial commit", user);
  return legacyArchive(repo);
}

test("runGit releases the project database lock before R2 reads for status, diff, and commit", async () => {
  const repoKey = `git/${projectId}/initial.json`;
  const sourceKey = `projects/${projectId}/sources/v1`;
  const objects = new Map<string, Uint8Array | string>([
    [repoKey, await seedRepo("before\n")],
    [sourceKey, "after\n"],
  ]);
  const harness = createHarness({
    initialLinked: {
      projectId,
      provider: "github",
      url: remoteUrl,
      objectKey: repoKey,
      branch: "main",
    },
    initialNodes: [
      makeNode({ id: rootId, name: "root", kind: "folder" }),
      makeNode({
        id: mainId,
        parentId: rootId,
        name: "main.tex",
        kind: "text",
        objectKey: sourceKey,
      }),
    ],
    objects,
  });

  const statusResult = await runGit({
    db: harness.db,
    bucket: harness.bucket,
    lock: harness.lock,
    accessToken: async () => "unused",
    projectId,
    user,
    action: { kind: "status" },
  });
  expect(statusResult.status.changes).toEqual([
    { path: "main.tex", status: "modified" },
  ]);

  const diffResult = await runGit({
    db: harness.db,
    bucket: harness.bucket,
    lock: harness.lock,
    accessToken: async () => "unused",
    projectId,
    user,
    action: { kind: "diff" },
  });
  expect(diffResult.diff).toContain("-before");
  expect(diffResult.diff).toContain("+after");

  const commitResult = await runGit({
    db: harness.db,
    bucket: harness.bucket,
    lock: harness.lock,
    accessToken: async () => "unused",
    projectId,
    user,
    action: { kind: "commit", message: "Update main.tex" },
  });
  expect(commitResult.status.changes).toEqual([]);
  expect(harness.reads.length).toBeGreaterThan(0);

  // The commit converted the clone, and recorded the blob of each source.
  const savedKey = harness.getLinked()?.objectKey ?? "";
  expect(savedKey).toEndWith(".bin");
  harness.reads.length = 0;
  const cleanStatus = await runGit({
    db: harness.db,
    bucket: harness.bucket,
    lock: harness.lock,
    accessToken: async () => "unused",
    projectId,
    user,
    action: { kind: "status" },
  });
  expect(cleanStatus.status.changes).toEqual([]);
  expect(cleanStatus.status.commits[0]?.message).toBe("Update main.tex");
  expect(harness.reads).toEqual([savedKey]);
  expect(harness.lockedReads).toEqual([]);
});

test("runGit status retries once when an object is retired and collected between snapshot and R2 read", async () => {
  const repoKey = `git/${projectId}/initial.json`;
  const staleKey = `projects/${projectId}/sources/stale`;
  const freshKey = `projects/${projectId}/sources/fresh`;
  const objects = new Map<string, Uint8Array | string>([
    [repoKey, await seedRepo("before\n")],
    [freshKey, "fresh edit\n"],
  ]);
  const harness = createHarness({
    initialLinked: {
      projectId,
      provider: "github",
      url: remoteUrl,
      objectKey: repoKey,
      branch: "main",
    },
    initialNodes: [
      makeNode({ id: rootId, name: "root", kind: "folder" }),
      makeNode({
        id: mainId,
        parentId: rootId,
        name: "main.tex",
        kind: "text",
        objectKey: staleKey,
        updatedAt: new Date(1),
      }),
    ],
    objects,
    onBucketGet(key) {
      if (key === staleKey) {
        harness.setNodes([
          makeNode({ id: rootId, name: "root", kind: "folder" }),
          makeNode({
            id: mainId,
            parentId: rootId,
            name: "main.tex",
            kind: "text",
            objectKey: freshKey,
            updatedAt: new Date(2),
          }),
        ]);
      }
    },
  });

  const result = await runGit({
    db: harness.db,
    bucket: harness.bucket,
    lock: harness.lock,
    accessToken: async () => "unused",
    projectId,
    user,
    action: { kind: "status" },
  });
  expect(result.status.changes).toEqual([
    { path: "main.tex", status: "modified" },
  ]);
  expect(harness.lockedReads).toEqual([]);
});

test("runGit reports missing R2 objects when DB pointers have not changed", async () => {
  const repoKey = `git/${projectId}/missing.json`;
  const harness = createHarness({
    initialLinked: {
      projectId,
      provider: "github",
      url: remoteUrl,
      objectKey: repoKey,
      branch: "main",
    },
    initialNodes: [makeNode({ id: rootId, name: "root", kind: "folder" })],
    objects: new Map(),
  });

  await expect(
    runGit({
      db: harness.db,
      bucket: harness.bucket,
      lock: harness.lock,
      accessToken: async () => "unused",
      projectId,
      user,
      action: { kind: "status" },
    }),
  ).rejects.toThrow("Saved git repository is missing.");
});

test("runGit mutating actions report concurrent change instead of missing object when collected", async () => {
  const repoKey = `git/${projectId}/initial.json`;
  const staleKey = `projects/${projectId}/sources/stale`;
  const freshKey = `projects/${projectId}/sources/fresh`;
  const objects = new Map<string, Uint8Array | string>([
    [repoKey, await seedRepo("before\n")],
    [freshKey, "fresh\n"],
  ]);
  const harness = createHarness({
    initialLinked: {
      projectId,
      provider: "github",
      url: remoteUrl,
      objectKey: repoKey,
      branch: "main",
    },
    initialNodes: [
      makeNode({ id: rootId, name: "root", kind: "folder" }),
      makeNode({
        id: mainId,
        parentId: rootId,
        name: "main.tex",
        kind: "text",
        objectKey: staleKey,
        updatedAt: new Date(1),
      }),
    ],
    objects,
    onBucketGet(key) {
      if (key === staleKey) {
        harness.setNodes([
          makeNode({ id: rootId, name: "root", kind: "folder" }),
          makeNode({
            id: mainId,
            parentId: rootId,
            name: "main.tex",
            kind: "text",
            objectKey: freshKey,
            updatedAt: new Date(2),
          }),
        ]);
      }
    },
  });

  await expect(
    runGit({
      db: harness.db,
      bucket: harness.bucket,
      lock: harness.lock,
      accessToken: async () => "unused",
      projectId,
      user,
      action: { kind: "commit", message: "Stale commit" },
    }),
  ).rejects.toThrow(/changed while Git was syncing/);
});

test("gitVersion returns empty string when unlinked and the repository objectKey when linked", async () => {
  const harness = createHarness({
    initialLinked: undefined,
    initialNodes: [],
    objects: new Map(),
  });
  expect(await gitVersion(harness.tx() as never, projectId)).toBe("");
  harness.setLinked({
    projectId,
    provider: "github",
    url: remoteUrl,
    objectKey: `git/${projectId}/abc.json`,
    branch: "main",
  });
  expect(await gitVersion(harness.tx() as never, projectId)).toBe(
    `git/${projectId}/abc.json`,
  );
});

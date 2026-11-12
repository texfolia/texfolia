import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import { projectCollaborator, projectNode, user } from "@texfolia/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";

import { createProjectNode } from "../src/lib/project-node.server";
import {
  encodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
  sourceContentSchema,
} from "../src/lib/project-source";
import {
  collectProjectSources,
  deleteProjectNode,
  readProjectSource,
  saveProjectSource,
  type SourceBucket,
} from "../src/lib/project-source.server";
import {
  createProject,
  deleteProject,
  getProject,
} from "../src/lib/project.server";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString,
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres database",
);
assert(
  new URL(connectionString).pathname.includes("test"),
  "Use a database with 'test' in its name",
);
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
  connectionString;
const directory = await mkdtemp(join(tmpdir(), "texfolia-sources-"));
const platform = await getPlatformProxy<{ SOURCES: SourceBucket }>({
  configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
  envFiles: [],
  persist: { path: directory },
  remoteBindings: false,
});
const bucket = platform.env.SOURCES;
const db = createDb(connectionString);
const ownerId = crypto.randomUUID();
const viewerId = crypto.randomUUID();
const editorId = crypto.randomUUID();
const source = (text: string) => encodeSource(new TextEncoder().encode(text));
try {
  for (const id of [ownerId, viewerId, editorId])
    await db.insert(user).values({
      id,
      name: "Source test",
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  const created = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: `Sources ${crypto.randomUUID()}` },
  });
  const projectId = created.id;
  const initial = await getProject({ db, bucket, ownerId, projectId });
  const main = initial.nodes.find((node) => node.name === "main.tex");
  const root = initial.nodes.find((node) => node.parentId === null);
  assert(main && root);
  await db.insert(projectCollaborator).values([
    { projectId, userId: viewerId, role: "viewer" },
    { projectId, userId: editorId, role: "editor" },
  ]);
  const saved = await saveProjectSource({
    db,
    bucket,
    userId: ownerId,
    data: {
      projectId,
      nodeId: main.id,
      expectedObjectKey: null,
      content: source("é 🦉"),
    },
  });
  assert.match(
    saved.objectKey,
    new RegExp(`^projects/${projectId}/sources/[0-9a-f]{64}$`),
  );
  assert.equal(
    saved.objectKey,
    `projects/${projectId}/sources/${createHash("sha256").update("é 🦉").digest("hex")}`,
  );
  const row = await db.query.projectNode.findFirst({ where: { id: main.id } });
  assert.equal(row?.sizeBytes, 7n);
  assert.equal(row?.objectKey, saved.objectKey);
  assert.equal(row?.updatedAt.getTime(), saved.updatedAt);
  assert.equal(await (await bucket.get(saved.objectKey))?.text(), "é 🦉");

  const fresh = await getProject({ db, bucket, ownerId: viewerId, projectId });
  assert.equal(fresh.sourceContents[main.id], "é 🦉");
  assert.equal(fresh.canWrite, false);
  await assert.rejects(
    saveProjectSource({
      db,
      bucket,
      userId: viewerId,
      data: {
        projectId,
        nodeId: main.id,
        expectedObjectKey: saved.objectKey,
        content: source("forbidden"),
      },
    }),
    /Project not found/,
  );
  await assert.rejects(
    createProjectNode({
      db,
      bucket,
      ownerId: viewerId,
      data: {
        id: crypto.randomUUID(),
        projectId,
        parentId: root.id,
        name: "forbidden.bin",
        kind: "binary",
        content: "AA==",
      },
    }),
    /Project not found/,
  );
  await assert.rejects(
    readProjectSource({
      db,
      bucket,
      userId: crypto.randomUUID(),
      projectId,
      nodeId: main.id,
    }),
    /Project not found/,
  );

  const edited = await saveProjectSource({
    db,
    bucket,
    userId: editorId,
    data: {
      projectId,
      nodeId: main.id,
      expectedObjectKey: saved.objectKey,
      content: source("editor saved"),
    },
  });
  await assert.rejects(
    saveProjectSource({
      db,
      bucket,
      userId: ownerId,
      data: {
        projectId,
        nodeId: main.id,
        expectedObjectKey: saved.objectKey,
        content: source("stale overwrite"),
      },
    }),
    /changed on the server/,
  );
  await collectProjectSources({ db, bucket });
  assert.equal(await bucket.get(saved.objectKey), null);
  assert(await bucket.get(edited.objectKey));

  const binaryBytes = new Uint8Array([0, 1, 127, 128, 255]);
  const binary = await createProjectNode({
    db,
    bucket,
    ownerId: editorId,
    data: {
      id: crypto.randomUUID(),
      projectId,
      parentId: root.id,
      name: "image.png",
      kind: "binary",
      content: encodeSource(binaryBytes),
    },
  });
  const duplicate = await createProjectNode({
    db,
    bucket,
    ownerId,
    data: {
      id: crypto.randomUUID(),
      projectId,
      parentId: root.id,
      name: "duplicate.png",
      kind: "binary",
      content: encodeSource(binaryBytes),
    },
  });
  assert.equal(
    binary.sourceVersion.objectKey,
    duplicate.sourceVersion.objectKey,
  );
  assert.deepEqual(
    await readProjectSource({
      db,
      bucket,
      userId: viewerId,
      projectId,
      nodeId: binary.id,
    }),
    binaryBytes,
  );
  assert.equal(
    (await db.query.projectNode.findFirst({ where: { id: binary.id } }))
      ?.sizeBytes,
    5n,
  );
  const binaryEdit = await saveProjectSource({
    db,
    bucket,
    userId: editorId,
    data: {
      projectId,
      nodeId: binary.id,
      expectedObjectKey: binary.sourceVersion.objectKey,
      content: "AAEC",
    },
  });
  assert.deepEqual(
    await readProjectSource({
      db,
      bucket,
      userId: viewerId,
      projectId,
      nodeId: binary.id,
    }),
    new Uint8Array([0, 1, 2]),
  );
  await assert.rejects(
    deleteProjectNode({ db, userId: viewerId, projectId, nodeId: binary.id }),
    /Project not found/,
  );
  await deleteProjectNode({
    db,
    userId: editorId,
    projectId,
    nodeId: binary.id,
  });
  await collectProjectSources({ db, bucket });
  assert.equal(await bucket.get(binaryEdit.objectKey), null);
  assert(await bucket.get(duplicate.sourceVersion.objectKey ?? ""));

  await assert.rejects(
    createProjectNode({
      db,
      bucket,
      ownerId,
      data: {
        id: crypto.randomUUID(),
        projectId,
        parentId: root.id,
        name: "duplicate.png",
        kind: "binary",
        content: source("orphan on failed DB insert"),
      },
    }),
  );
  const beforeSweep = await bucket.list({
    prefix: `projects/${projectId}/sources/`,
  });
  await collectProjectSources({ db, bucket });
  const afterSweep = await bucket.list({
    prefix: `projects/${projectId}/sources/`,
  });
  assert.equal(beforeSweep.objects.length - afterSweep.objects.length, 1);
  assert.equal(
    (await getProject({ db, bucket, ownerId, projectId })).sourceContents[
      main.id
    ],
    "editor saved",
  );

  const failureBucket: SourceBucket = {
    get: bucket.get.bind(bucket),
    list: bucket.list.bind(bucket),
    delete: bucket.delete.bind(bucket),
    put: async () => {
      throw new Error("R2 unavailable");
    },
  };
  await assert.rejects(
    saveProjectSource({
      db,
      bucket: failureBucket,
      userId: ownerId,
      data: {
        projectId,
        nodeId: main.id,
        expectedObjectKey: edited.objectKey,
        content: source("must not commit"),
      },
    }),
    /R2 unavailable/,
  );
  assert.equal(
    (await db.query.projectNode.findFirst({ where: { id: main.id } }))
      ?.objectKey,
    edited.objectKey,
  );

  const folder = await createProjectNode({
    db,
    bucket,
    ownerId,
    data: {
      id: crypto.randomUUID(),
      projectId,
      parentId: root.id,
      name: "nested",
      kind: "folder",
    },
  });
  const bib = await createProjectNode({
    db,
    bucket,
    ownerId,
    data: {
      id: crypto.randomUUID(),
      projectId,
      parentId: folder.id,
      name: "refs.bib",
      kind: "text",
      content: source("@book{é}"),
    },
  });
  assert.equal(
    (await getProject({ db, bucket, ownerId, projectId })).sourceContents[
      bib.id
    ],
    "@book{é}",
  );
  await deleteProjectNode({
    db,
    userId: ownerId,
    projectId,
    nodeId: folder.id,
  });
  await assert.rejects(
    readProjectSource({
      db,
      bucket,
      userId: ownerId,
      projectId,
      nodeId: bib.id,
    }),
    /File not found/,
  );
  await collectProjectSources({ db, bucket });
  assert.equal(await bucket.get(bib.sourceVersion.objectKey ?? ""), null);

  await assert.rejects(
    saveProjectSource({
      db,
      bucket,
      userId: ownerId,
      data: {
        projectId,
        nodeId: main.id,
        expectedObjectKey: edited.objectKey,
        content: encodeSource(new Uint8Array(maxSourceFileBytes + 1)),
      },
    }),
    /File exceeds/,
  );
  const quotaProject = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: `Quota ${crypto.randomUUID()}` },
  });
  const quotaRoot = (
    await getProject({ db, bucket, ownerId, projectId: quotaProject.id })
  ).nodes.find((node) => node.parentId === null);
  assert(quotaRoot);
  const tenMiB = encodeSource(new Uint8Array(maxSourceFileBytes));
  assert.equal(sourceContentSchema.parse(tenMiB).length, tenMiB.length);
  for (let index = 0; index < 4; index++)
    await createProjectNode({
      db,
      bucket,
      ownerId,
      data: {
        id: crypto.randomUUID(),
        projectId: quotaProject.id,
        parentId: quotaRoot.id,
        name: `asset-${index}.bin`,
        kind: "binary",
        content: tenMiB,
      },
    });
  const concurrent = await Promise.allSettled(
    ["a.bin", "b.bin"].map((name) =>
      createProjectNode({
        db,
        bucket,
        ownerId,
        data: {
          id: crypto.randomUUID(),
          projectId: quotaProject.id,
          parentId: quotaRoot.id,
          name,
          kind: "binary",
          content: tenMiB,
        },
      }),
    ),
  );
  assert.equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const [usage] = await db
    .select({ total: sql<string>`sum(${projectNode.sizeBytes})` })
    .from(projectNode)
    .where(
      and(
        eq(projectNode.projectId, quotaProject.id),
        isNull(projectNode.deletedAt),
      ),
    );
  assert.equal(BigInt(usage?.total ?? 0), BigInt(maxSourceProjectBytes));
  await Promise.all(
    Array.from({ length: 105 }, (_, index) => {
      const text = `orphan-${index}`;
      const hash = createHash("sha256").update(text).digest("hex");
      return bucket.put(`projects/${projectId}/sources/${hash}`, text);
    }),
  );
  await collectProjectSources({ db, bucket });
  assert.equal(
    (await bucket.list({ prefix: `projects/${projectId}/sources/` })).objects
      .length,
    2,
  );
  const competingSaves = await Promise.allSettled(
    ["race-a", "race-b"].map((text) =>
      saveProjectSource({
        db,
        bucket,
        userId: editorId,
        data: {
          projectId,
          nodeId: main.id,
          expectedObjectKey: edited.objectKey,
          content: source(text),
        },
      }),
    ),
  );
  assert.equal(
    competingSaves.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert(
    ["race-a", "race-b"].includes(
      (await getProject({ db, bucket, ownerId, projectId })).sourceContents[
        main.id
      ] ?? "",
    ),
  );
  await deleteProject({ db, ownerId, projectId: quotaProject.id });
  await deleteProject({ db, ownerId, projectId });
  await collectProjectSources({ db, bucket });
  assert.equal(
    (await bucket.list({ prefix: `projects/${projectId}/sources/` })).objects
      .length,
    0,
  );
  assert.equal(
    (await bucket.list({ prefix: `projects/${quotaProject.id}/sources/` }))
      .objects.length,
    0,
  );
  console.log(
    "Source integration passed: real local R2, fresh reads, UTF-8 bytes, binary uploads, auth, conflicts, rollback, deduplication, recursive deletion, orphan GC, and concurrent quotas",
  );
} finally {
  for (const id of [ownerId, viewerId, editorId])
    await db.delete(user).where(eq(user.id, id));
  await db.$client.end();
  await platform.dispose();
  await rm(directory, { recursive: true, force: true });
}

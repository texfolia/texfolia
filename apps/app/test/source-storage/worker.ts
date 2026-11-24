import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createDb, type Db } from "@texfolia/db";
import {
  projectCollaboration,
  projectCollaborator,
  projectNode,
  sourceGarbage,
  user,
} from "@texfolia/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

import { projectMetadataVersion } from "#/lib/projects";
import {
  encodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
  sourceContentSchema,
} from "#/lib/storage";
import { type SourceBucket, sweepProjectSources } from "#/lib/storage/server";

import { compileResync } from "../../src/lib/compile/compile-source.server";
import { getProjectMetadata } from "../../src/lib/projects/project-metadata.server";
import {
  createProjectNode,
  renameProjectNode,
} from "../../src/lib/projects/project-node.server";
import {
  collectProjectSources,
  deleteProjectNode,
  readProjectSource,
  saveProjectSource,
} from "../../src/lib/projects/project-source.server";
import {
  createProject,
  deleteTrashedProject,
  getProject,
  trashProject,
} from "../../src/lib/projects/project.server";

export { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration.server";

async function deleteForever(db: Db, userId: string, projectId: string) {
  await trashProject({ db, userId, projectId });
  await deleteTrashedProject({ db, userId, projectId });
}

export default {
  async fetch(_request: Request, env: Env) {
    const db = createDb(env.HYPERDRIVE.connectionString);
    const bucket = env.SOURCES;
    const ownerId = crypto.randomUUID();
    const viewerId = crypto.randomUUID();
    const editorId = crypto.randomUUID();
    const source = (text: string) =>
      encodeSource(new TextEncoder().encode(text));
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
        data: {
          id: crypto.randomUUID(),
          name: `Sources ${crypto.randomUUID()}`,
        },
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
      const pathProject = await createProject({
        db,
        ownerId,
        data: { id: crypto.randomUUID(), name: `Paths ${crypto.randomUUID()}` },
      });
      const pathDetails = await getProject({
        db,
        bucket,
        ownerId,
        projectId: pathProject.id,
      });
      const pathRoot = pathDetails.nodes.find((node) => node.parentId === null);
      assert(pathRoot);
      const pathFolder = await createProjectNode({
        db,
        bucket,
        ownerId,
        data: {
          id: crypto.randomUUID(),
          projectId: pathProject.id,
          parentId: pathRoot.id,
          name: "a".repeat(230),
          kind: "folder",
        },
      });
      const objectsBefore = (
        await bucket.list({ prefix: `projects/${pathProject.id}/sources/` })
      ).objects;
      for (const [parentId, name] of [
        [pathRoot.id, "chapter:1.tex"],
        [pathRoot.id, "a".repeat(241)],
        [pathRoot.id, "é".repeat(121)],
        [pathRoot.id, "OUT"],
        [pathFolder.id, "a".repeat(10)],
      ]) {
        const id = crypto.randomUUID();
        await assert.rejects(
          createProjectNode({
            db,
            bucket,
            ownerId,
            data: {
              id,
              projectId: pathProject.id,
              parentId: parentId ?? "",
              name: name ?? "",
              kind: "binary",
              content: source("must not store"),
            },
          }),
        );
        assert.equal(
          await db.query.projectNode.findFirst({ where: { id } }),
          undefined,
        );
      }
      assert.deepEqual(
        (await bucket.list({ prefix: `projects/${pathProject.id}/sources/` }))
          .objects,
        objectsBefore,
      );
      const boundary = await createProjectNode({
        db,
        bucket,
        ownerId,
        data: {
          id: crypto.randomUUID(),
          projectId: pathProject.id,
          parentId: pathFolder.id,
          name: "12345.tex",
          kind: "text",
          content: source("preserved source"),
        },
      });
      await assert.rejects(
        renameProjectNode({
          db,
          userId: ownerId,
          data: {
            projectId: pathProject.id,
            nodeId: pathFolder.id,
            parentId: pathRoot.id,
            name: "b".repeat(231),
          },
        }),
        /240 UTF-8 bytes/,
      );
      // Simulate previously stored invalid paths, including an unreferenced source.
      await db
        .update(projectNode)
        .set({ name: "chapter:1.tex" })
        .where(eq(projectNode.id, boundary.id));
      await assert.rejects(
        compileResync({
          db,
          bucket,
          userId: ownerId,
          projectId: pathProject.id,
          mainFile: "main.tex",
          sourceRevision: 0,
        }),
        /Repair source paths/,
      );
      const invalidMetadata = await getProjectMetadata({
        db,
        projectId: pathProject.id,
        userId: ownerId,
      });
      await assert.rejects(
        compileResync({
          db,
          bucket,
          userId: ownerId,
          projectId: pathProject.id,
          mainFile: "main.tex",
          sourceRevision: 0,
          client: {
            version: await projectMetadataVersion(invalidMetadata),
            delta: {
              mainFile: "main.tex",
              baseRevision: 0,
              revision: 1,
              files: {},
              deleted: [],
            },
          },
        }),
        /Repair source paths/,
      );
      await assert.rejects(
        renameProjectNode({
          db,
          userId: viewerId,
          data: {
            projectId: pathProject.id,
            nodeId: boundary.id,
            parentId: pathFolder.id,
            name: "intro.tex",
          },
        }),
        /Project not found/,
      );
      await renameProjectNode({
        db,
        userId: ownerId,
        data: {
          projectId: pathProject.id,
          nodeId: pathFolder.id,
          parentId: pathRoot.id,
          name: "chapters",
        },
      });
      await renameProjectNode({
        db,
        userId: ownerId,
        data: {
          projectId: pathProject.id,
          nodeId: boundary.id,
          parentId: pathFolder.id,
          name: "intro.tex",
        },
      });
      const recovered = await db.query.projectNode.findFirst({
        where: { id: boundary.id },
      });
      assert.equal(recovered?.parentId, pathFolder.id);
      assert.equal(recovered?.objectKey, boundary.sourceVersion.objectKey);
      assert.equal(
        await (await bucket.get(recovered?.objectKey ?? ""))?.text(),
        "preserved source",
      );
      const recoveredSources = await compileResync({
        db,
        bucket,
        userId: ownerId,
        projectId: pathProject.id,
        mainFile: "main.tex",
        sourceRevision: 0,
      });
      assert.equal(
        recoveredSources.files["chapters/intro.tex"]?.content,
        "preserved source",
      );
      await renameProjectNode({
        db,
        userId: ownerId,
        data: {
          projectId: pathProject.id,
          nodeId: boundary.id,
          parentId: pathRoot.id,
          name: "intro.tex",
        },
      });
      const moved = await db.query.projectNode.findFirst({
        where: { id: boundary.id },
      });
      assert.equal(moved?.parentId, pathRoot.id);
      assert.equal(moved?.objectKey, boundary.sourceVersion.objectKey);
      await assert.rejects(
        renameProjectNode({
          db,
          userId: ownerId,
          data: {
            projectId: pathProject.id,
            nodeId: pathFolder.id,
            parentId: pathFolder.id,
            name: "chapters",
          },
        }),
        /subtree/,
      );
      await deleteForever(db, ownerId, pathProject.id);
      await db
        .insert(projectCollaboration)
        .values({ projectId: pathProject.id });
      const retiredSnapshotKey = `history/${pathProject.id}/obsolete.yjs`;
      await bucket.put(retiredSnapshotKey, "prelaunch snapshot");
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
      assert.equal(await bucket.get(retiredSnapshotKey), null);
      assert.equal(
        (
          await db
            .select()
            .from(projectCollaboration)
            .where(eq(projectCollaboration.projectId, pathProject.id))
        ).length,
        0,
      );

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
      const row = await db.query.projectNode.findFirst({
        where: { id: main.id },
      });
      assert.equal(row?.sizeBytes, 7n);
      assert.equal(row?.objectKey, saved.objectKey);
      assert.equal(row?.updatedAt.getTime(), saved.updatedAt);
      assert.equal(await (await bucket.get(saved.objectKey))?.text(), "é 🦉");

      const fresh = await getProject({
        db,
        bucket,
        ownerId: viewerId,
        projectId,
      });
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
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
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
      const resync = await compileResync({
        db,
        bucket,
        projectId,
        userId: editorId,
        mainFile: "main.tex",
        sourceRevision: 7,
      });
      assert.equal(resync.baseRevision, 7);
      assert.equal(resync.revision, 8);
      assert.equal(resync.resync, true);
      assert.equal(
        resync.files["main.tex"]?.hash,
        edited.objectKey.split("/").at(-1),
      );
      assert.equal(
        resync.files["image.png"]?.hash,
        binary.sourceVersion.objectKey?.split("/").at(-1),
      );
      assert.deepEqual(resync.files["image.png"]?.content, {
        base64: encodeSource(binaryBytes),
      });
      await assert.rejects(
        compileResync({
          db,
          bucket,
          projectId,
          userId: viewerId,
          mainFile: "main.tex",
          sourceRevision: 7,
        }),
        /Project not found/,
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
        deleteProjectNode({
          db,
          userId: viewerId,
          projectId,
          nodeId: binary.id,
        }),
        /Project not found/,
      );
      await deleteProjectNode({
        db,
        userId: editorId,
        projectId,
        nodeId: binary.id,
      });
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
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
      // A rolled-back write never reaches the queue, so only the sweep sees it.
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
      assert.equal(
        (await bucket.list({ prefix: `projects/${projectId}/sources/` }))
          .objects.length,
        beforeSweep.objects.length,
      );
      await sweepProjectSources({ db, bucket });
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
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
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
      // Normal collection touches only queued keys, never the rest of the bucket.
      const listing: SourceBucket = {
        get: bucket.get.bind(bucket),
        put: bucket.put.bind(bucket),
        delete: bucket.delete.bind(bucket),
        list: async () => {
          throw new Error("Queued collection must not list the bucket");
        },
      };
      await collectProjectSources({
        db,
        bucket: listing,
        collaboration: env.COLLABORATION,
      });
      assert.equal(
        (await bucket.list({ prefix: `projects/${projectId}/sources/` }))
          .objects.length,
        107,
      );
      await sweepProjectSources({ db, bucket });
      assert.equal(
        (await bucket.list({ prefix: `projects/${projectId}/sources/` }))
          .objects.length,
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
      await deleteForever(db, ownerId, quotaProject.id);
      await deleteForever(db, ownerId, projectId);
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
      assert.equal(
        (
          await db
            .select()
            .from(sourceGarbage)
            .where(eq(sourceGarbage.projectId, projectId))
        ).length,
        0,
      );
      assert.equal(
        (await bucket.list({ prefix: `projects/${projectId}/sources/` }))
          .objects.length,
        0,
      );
      assert.equal(
        (await bucket.list({ prefix: `projects/${quotaProject.id}/sources/` }))
          .objects.length,
        0,
      );
      return new Response(
        "Source integration passed: real local R2, fresh reads, UTF-8 bytes, binary uploads, auth, conflicts, rollback, deduplication, recursive deletion, orphan GC, and concurrent quotas",
      );
    } finally {
      for (const id of [ownerId, viewerId, editorId])
        await db.delete(user).where(eq(user.id, id));
      await db.$client.end();
    }
  },
} satisfies ExportedHandler<Env>;

import assert from "node:assert/strict";

import { createDb, type Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  projectNode,
  projectShareLink,
  tag,
  user,
} from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";

import type { CollaborationCleanup } from "#/lib/collaboration/server";
import {
  projectPaths,
  projectTagsSchema,
  trashRetentionDays,
} from "#/lib/projects";
import { encodeSource, maxSourceFileBytes } from "#/lib/storage";
import { sweepProjectSources, type SourceBucket } from "#/lib/storage/server";

import { importProjectFiles } from "../../src/lib/projects/project-import.server";
import {
  collectProjectSources,
  saveProjectSource,
  readProjectSource,
} from "../../src/lib/projects/project-source.server";
import {
  createProject,
  deleteExpiredProjects,
  deleteTrashedProject,
  duplicateProject,
  getProject,
  getProjects,
  getTrashedProjects,
  renameProject,
  restoreProject,
  setProjectTags,
  trashProject,
} from "../../src/lib/projects/project.server";
import { sharePrincipal } from "../../src/lib/sharing/project-access.server";
import {
  createShareLink,
  getSharedProject,
} from "../../src/lib/sharing/project-share-links.server";
import { transferProject } from "../../src/lib/sharing/project-transfer.server";

export { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration.server";

async function checkLifecycle({
  db,
  bucket,
  collaboration,
  ownerId,
  viewerId,
  editorId,
  strangerId,
  organizationId,
  projectId,
  orgProjectId,
}: {
  db: Db;
  bucket: SourceBucket;
  collaboration: CollaborationCleanup;
  ownerId: string;
  viewerId: string;
  editorId: string;
  strangerId: string;
  organizationId: string;
  projectId: string;
  orgProjectId: string;
}) {
  const objects = async (id: string) =>
    (await bucket.list({ prefix: `projects/${id}/sources/` })).objects.length;
  const collect = async () => {
    await collectProjectSources({ db, bucket, collaboration });
    await sweepProjectSources({ db, bucket });
  };
  const listed = async (userId: string, id: string) =>
    (await getProjects({ db, userId })).projects.find((item) => item.id === id);
  const sources = async (userId: string, id: string) => {
    const loaded = await getProject({
      db,
      bucket,
      ownerId: userId,
      projectId: id,
    });
    const result: Record<string, string> = {};
    for (const [nodeId, path] of projectPaths(loaded.nodes))
      result[path] = encodeSource(
        await readProjectSource({
          db,
          bucket,
          userId,
          projectId: id,
          nodeId,
        }),
      );
    return result;
  };
  await db.insert(projectCollaborator).values([
    { projectId, userId: viewerId, role: "viewer" },
    { projectId, userId: editorId, role: "editor" },
  ]);
  const link = await createShareLink({
    db,
    userId: ownerId,
    data: { projectId, scope: "project" },
  });
  const guest = sharePrincipal(link.id);
  const outsiders = [viewerId, editorId, strangerId, guest];

  // Trash: only a manager, and everything is kept until the row is deleted.
  for (const userId of outsiders)
    await assert.rejects(
      trashProject({ db, userId, projectId }),
      /Project not found/,
    );
  await assert.rejects(
    deleteTrashedProject({ db, userId: ownerId, projectId }),
    /Project not found/,
    "A live project cannot be permanently deleted",
  );
  const before = await sources(ownerId, projectId);
  await trashProject({ db, userId: ownerId, projectId });
  for (const userId of [ownerId, viewerId, editorId]) {
    assert.equal(await listed(userId, projectId), undefined);
    await assert.rejects(
      getProject({ db, bucket, ownerId: userId, projectId }),
      /Project not found/,
    );
  }
  await assert.rejects(
    getSharedProject({ db, token: link.token }),
    /Project not found/,
  );
  await assert.rejects(
    trashProject({ db, userId: ownerId, projectId }),
    /Project not found/,
  );
  assert.deepEqual(
    (await getTrashedProjects({ db, userId: ownerId })).map((item) => item.id),
    [projectId],
  );
  for (const userId of outsiders) {
    assert.equal((await getTrashedProjects({ db, userId })).length, 0);
    await assert.rejects(
      restoreProject({ db, userId, projectId }),
      /Project not found/,
    );
    await assert.rejects(
      deleteTrashedProject({ db, userId, projectId }),
      /Project not found/,
    );
    await assert.rejects(
      duplicateProject({ db, bucket, userId, projectId }),
      /Project not found/,
    );
  }
  await deleteExpiredProjects({ db });
  await collect();

  // Restoring keeps sources and sharing, and avoids a name that was reused.
  const trashedName = (
    await db.query.project.findFirst({ where: { id: projectId } })
  )?.name;
  assert(trashedName);
  await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: trashedName },
  });
  assert.deepEqual(await restoreProject({ db, userId: ownerId, projectId }), {
    id: projectId,
    name: `${trashedName} (2)`,
  });
  assert.deepEqual(await sources(ownerId, projectId), before);
  assert.equal((await listed(viewerId, projectId))?.canWrite, false);
  assert.equal(
    (await getSharedProject({ db, token: link.token })).projectId,
    projectId,
  );
  await assert.rejects(
    restoreProject({ db, userId: ownerId, projectId }),
    /Project not found/,
  );

  // Duplicate: any signed-in reader gets an independent personal copy.
  await db
    .update(project)
    .set({ formatIndent: 4, spellcheckLanguage: "off" })
    .where(eq(project.id, projectId));
  for (const userId of [strangerId, guest])
    await assert.rejects(
      duplicateProject({ db, bucket, userId, projectId }),
      /Project not found/,
    );
  const copy = await duplicateProject({
    db,
    bucket,
    userId: viewerId,
    projectId,
  });
  assert.equal(copy.name, `${trashedName} (2) copy`);
  assert.equal(
    (await duplicateProject({ db, bucket, userId: viewerId, projectId })).name,
    `${trashedName} (2) copy (2)`,
  );
  assert.deepEqual(await sources(viewerId, copy.id), before);
  const copied = await listed(viewerId, copy.id);
  assert.equal(copied?.ownerId, viewerId);
  assert.equal(copied?.canManage, true);
  assert.equal(copied?.formatIndent, 4);
  assert.equal(copied?.spellcheckLanguage, "off");
  assert.equal(copied?.people.length, 1, "Collaborators are not copied");
  assert.equal(
    (
      await db
        .select()
        .from(projectShareLink)
        .where(eq(projectShareLink.projectId, copy.id))
    ).length,
    0,
    "Share links are not copied",
  );
  await assert.rejects(
    getProject({ db, bucket, ownerId, projectId: copy.id }),
    /Project not found/,
  );
  const failing: SourceBucket = {
    get: bucket.get.bind(bucket),
    list: bucket.list.bind(bucket),
    delete: bucket.delete.bind(bucket),
    put: async () => {
      throw new Error("Storage unavailable");
    },
  };
  const ownedBefore = (await getProjects({ db, userId: viewerId })).projects
    .length;
  await assert.rejects(
    duplicateProject({ db, bucket: failing, userId: viewerId, projectId }),
    /Storage unavailable/,
  );
  assert.equal(
    (await getProjects({ db, userId: viewerId })).projects.length,
    ownedBefore,
    "A failed copy leaves no project",
  );

  // Permanent deletion removes the row and the source, but not its copies.
  await trashProject({ db, userId: viewerId, projectId: copy.id });
  await assert.rejects(
    deleteTrashedProject({ db, userId: ownerId, projectId: copy.id }),
    /Project not found/,
  );
  assert((await objects(copy.id)) > 0);
  await deleteTrashedProject({ db, userId: viewerId, projectId: copy.id });
  assert.equal(
    await db.query.project.findFirst({ where: { id: copy.id } }),
    undefined,
  );
  assert.equal(
    (
      await db
        .select()
        .from(projectNode)
        .where(eq(projectNode.projectId, copy.id))
    ).length,
    0,
  );
  await collectProjectSources({ db, bucket, collaboration });
  assert.equal(await objects(copy.id), 0);
  assert.deepEqual(await sources(ownerId, projectId), before);

  // Retention deletes only projects whose time is up.
  const day = 24 * 60 * 60 * 1000;
  const expiring = await duplicateProject({
    db,
    bucket,
    userId: viewerId,
    projectId,
  });
  await trashProject({ db, userId: viewerId, projectId: expiring.id });
  const age = (days: number) =>
    db
      .update(project)
      .set({ deletedAt: new Date(Date.now() - days * day) })
      .where(eq(project.id, expiring.id));
  await age(trashRetentionDays - 1);
  await deleteExpiredProjects({ db });
  assert(await db.query.project.findFirst({ where: { id: expiring.id } }));
  await age(trashRetentionDays + 1);
  await deleteExpiredProjects({ db });
  assert.equal(
    await db.query.project.findFirst({ where: { id: expiring.id } }),
    undefined,
  );
  await collectProjectSources({ db, bucket, collaboration });
  assert.equal(await objects(expiring.id), 0);

  // Transfer: a manager to someone with access; the previous owner can edit.
  for (const userId of outsiders)
    await assert.rejects(
      transferProject({ db, userId, data: { projectId, userId: viewerId } }),
      /Project not found/,
    );
  await assert.rejects(
    transferProject({
      db,
      userId: ownerId,
      data: { projectId, userId: strangerId },
    }),
    /Share the project/,
  );
  await assert.rejects(
    transferProject({
      db,
      userId: ownerId,
      data: { projectId, userId: ownerId },
    }),
    /someone else/,
  );
  const name = (await listed(ownerId, projectId))?.name;
  assert(name);
  await createProject({
    db,
    ownerId: viewerId,
    data: { id: crypto.randomUUID(), name },
  });
  assert.deepEqual(
    await transferProject({
      db,
      userId: ownerId,
      data: { projectId, userId: viewerId },
    }),
    { name: `${name} (2)` },
  );
  const received = await listed(viewerId, projectId);
  assert.equal(received?.ownerId, viewerId);
  assert.equal(received?.canManage, true);
  const former = await listed(ownerId, projectId);
  assert.equal(former?.canWrite, true);
  assert.equal(former?.canManage, false);
  assert.equal((await listed(editorId, projectId))?.canWrite, true);
  assert.deepEqual(
    (
      await db
        .select({ userId: projectCollaborator.userId })
        .from(projectCollaborator)
        .where(eq(projectCollaborator.projectId, projectId))
    )
      .map((row) => row.userId)
      .sort(),
    [editorId, ownerId].sort(),
  );
  await assert.rejects(
    getSharedProject({ db, token: link.token }),
    /not found/,
  );
  for (const action of [
    () => trashProject({ db, userId: ownerId, projectId }),
    () =>
      transferProject({
        db,
        userId: ownerId,
        data: { projectId, userId: editorId },
      }),
    () =>
      createShareLink({
        db,
        userId: ownerId,
        data: { projectId, scope: "project" },
      }),
  ])
    await assert.rejects(action(), /Project not found|Only the project owner/);

  // Organization projects: owners and admins manage, members receive.
  await db
    .insert(projectCollaborator)
    .values({ projectId: orgProjectId, userId: strangerId, role: "editor" });
  for (const action of [trashProject, restoreProject, deleteTrashedProject])
    await assert.rejects(
      action({ db, userId: strangerId, projectId: orgProjectId }),
      /Project not found/,
    );
  await assert.rejects(
    trashProject({ db, userId: editorId, projectId: orgProjectId }),
    /Only organization/,
  );
  await trashProject({ db, userId: ownerId, projectId: orgProjectId });
  assert.equal(
    (await getTrashedProjects({ db, userId: ownerId }))[0]?.organizationName,
    "Dashboard org",
  );
  assert.equal((await getTrashedProjects({ db, userId: editorId })).length, 0);
  for (const action of [restoreProject, deleteTrashedProject])
    await assert.rejects(
      action({ db, userId: editorId, projectId: orgProjectId }),
      /Only organization/,
    );
  await restoreProject({ db, userId: ownerId, projectId: orgProjectId });
  const orgCopy = await duplicateProject({
    db,
    bucket,
    userId: editorId,
    projectId: orgProjectId,
  });
  const orgCopied = await listed(editorId, orgCopy.id);
  assert.equal(orgCopied?.ownerId, editorId);
  assert.equal(orgCopied?.organizationId, null);
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: viewerId,
    role: "member",
    createdAt: new Date(),
  });
  await assert.rejects(
    transferProject({
      db,
      userId: editorId,
      data: { projectId: orgProjectId, userId: viewerId },
    }),
    /Only organization/,
  );
  await assert.rejects(
    transferProject({
      db,
      userId: ownerId,
      data: { projectId: orgProjectId, userId: strangerId },
    }),
    /Only organization members/,
  );
  await transferProject({
    db,
    userId: ownerId,
    data: { projectId: orgProjectId, userId: editorId },
  });
  const moved = await listed(editorId, orgProjectId);
  assert.equal(moved?.ownerId, editorId);
  assert.equal(moved?.organizationId, null);
  assert.equal(moved?.canManage, true);
  const formerAdmin = await listed(ownerId, orgProjectId);
  assert.equal(formerAdmin?.canWrite, true);
  assert.equal(formerAdmin?.canManage, false);
  for (const userId of [viewerId, strangerId])
    await assert.rejects(
      getProject({ db, bucket, ownerId: userId, projectId: orgProjectId }),
      /Project not found/,
      "Other members and stale collaborators lose access",
    );
}

export default {
  async fetch(_request: Request, env: Env) {
    const db = createDb(env.HYPERDRIVE.connectionString);
    const bucket = env.SOURCES;
    const [ownerId, viewerId, editorId, strangerId] = Array.from(
      { length: 4 },
      () => crypto.randomUUID(),
    );
    assert(ownerId && viewerId && editorId && strangerId);
    const organizationId = crypto.randomUUID();
    const source = (text: string) =>
      encodeSource(new TextEncoder().encode(text));
    try {
      await db.insert(user).values(
        [ownerId, viewerId, editorId, strangerId].map((id) => ({
          id,
          name: id,
          email: `${id}@example.com`,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
      const created = await createProject({
        db,
        ownerId,
        data: { id: crypto.randomUUID(), name: "Private labels" },
      });
      await db.insert(projectCollaborator).values([
        { projectId: created.id, userId: viewerId, role: "viewer" },
        { projectId: created.id, userId: editorId, role: "editor" },
      ]);
      await setProjectTags({
        db,
        ownerId,
        data: projectTagsSchema.parse({
          projectId: created.id,
          tags: [" Research ", "DRAFT", "research"],
        }),
      });
      await setProjectTags({
        db,
        ownerId: viewerId,
        data: { projectId: created.id, tags: ["research", "private"] },
      });
      assert.deepEqual(
        (await getProjects({ db, userId: ownerId })).projects[0]?.tags,
        ["draft", "research"],
      );
      const viewer = (await getProjects({ db, userId: viewerId })).projects[0];
      assert(viewer);
      assert.deepEqual(viewer.tags, ["private", "research"]);
      assert.equal(viewer.canWrite, false);
      assert.equal(viewer.canManage, false);
      assert.equal(viewer.people.length, 3);
      assert.equal(
        (await db.select().from(tag).where(eq(tag.name, "research"))).length,
        2,
        "Same normalized label belongs to separate user catalogs",
      );
      const beforeLabels = viewer.updatedAt;
      await setProjectTags({
        db,
        ownerId,
        data: { projectId: created.id, tags: [] },
      });
      assert.deepEqual(
        (await getProjects({ db, userId: viewerId })).projects[0]?.tags,
        ["private", "research"],
      );
      assert.equal(
        (
          await getProjects({ db, userId: viewerId })
        ).projects[0]?.updatedAt.getTime(),
        beforeLabels.getTime(),
        "Private tags do not alter project recency",
      );
      await assert.rejects(
        setProjectTags({
          db,
          ownerId: strangerId,
          data: { projectId: created.id, tags: ["inaccessible"] },
        }),
        /Project not found/,
      );
      await assert.rejects(
        renameProject({
          db,
          ownerId: viewerId,
          data: { projectId: created.id, name: "Unauthorized rename" },
        }),
        /Project not found/,
      );
      await renameProject({
        db,
        ownerId: editorId,
        data: { projectId: created.id, name: "Editor rename" },
      });
      assert.equal(
        (await getProjects({ db, userId: ownerId })).projects[0]?.name,
        "Editor rename",
      );
      await db
        .delete(projectCollaborator)
        .where(
          and(
            eq(projectCollaborator.projectId, created.id),
            eq(projectCollaborator.userId, viewerId),
          ),
        );
      await assert.rejects(
        setProjectTags({
          db,
          ownerId: viewerId,
          data: { projectId: created.id, tags: [] },
        }),
        /Project not found/,
      );
      assert.equal(
        (await getProjects({ db, userId: viewerId })).projects.length,
        0,
      );

      await db.insert(organization).values({
        id: organizationId,
        name: "Dashboard org",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(member).values([
        {
          id: crypto.randomUUID(),
          organizationId,
          userId: ownerId,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          organizationId,
          userId: editorId,
          role: "member",
          createdAt: new Date(),
        },
      ]);
      const [orgProject] = await db
        .insert(project)
        .values({ organizationId, name: "Organization project" })
        .returning();
      assert(orgProject);
      assert.equal(
        (await getProjects({ db, userId: ownerId })).projects.find(
          (item) => item.id === orgProject.id,
        )?.canManage,
        true,
      );
      const orgMember = (
        await getProjects({ db, userId: editorId })
      ).projects.find((item) => item.id === orgProject.id);
      assert(orgMember?.canWrite && !orgMember.canManage);
      assert.equal(orgMember.people.length, 2);

      const everything = await getProjects({ db, userId: ownerId });
      assert(everything.projects.length >= 2);
      assert.equal(everything.nextCursor, null);
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await getProjects({
          db,
          userId: ownerId,
          limit: 1,
          cursor,
        });
        assert(page.projects.length <= 1);
        paged.push(...page.projects.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(
        paged,
        everything.projects.map((item) => item.id),
        "Cursor pages walk the full list in recency order without gaps",
      );

      const imported = await importProjectFiles({
        db,
        bucket,
        ownerId,
        data: {
          name: "Uploaded project",
          files: [
            {
              path: "main.tex",
              kind: "text",
              content: source("\\documentclass{article}\n"),
            },
            {
              path: "chapters/intro.tex",
              kind: "text",
              content: source("A nested chapter."),
            },
            {
              path: "images/reference.pdf",
              kind: "binary",
              content: encodeSource(new Uint8Array([0, 255, 1, 128])),
            },
          ],
        },
      });
      const nodes = await db.query.projectNode.findMany({
        where: { projectId: imported.id },
      });
      assert.deepEqual([...projectPaths(nodes).values()].sort(), [
        "chapters/intro.tex",
        "images/reference.pdf",
        "main.tex",
      ]);
      const intro = nodes.find((node) => node.name === "intro.tex");
      const binary = nodes.find((node) => node.name === "reference.pdf");
      assert(intro && binary);
      assert.equal(
        new TextDecoder().decode(
          await readProjectSource({
            db,
            bucket,
            userId: ownerId,
            projectId: imported.id,
            nodeId: intro.id,
          }),
        ),
        "A nested chapter.",
      );
      assert.deepEqual(
        await readProjectSource({
          db,
          bucket,
          userId: ownerId,
          projectId: imported.id,
          nodeId: binary.id,
        }),
        new Uint8Array([0, 255, 1, 128]),
      );
      for (const files of [
        [{ path: "../main.tex", kind: "text", content: source("bad") }],
        [{ path: "out/main.tex", kind: "text", content: source("bad") }],
        [
          { path: "a.tex", kind: "text", content: source("one") },
          { path: "A.tex", kind: "text", content: source("two") },
        ],
        [
          { path: "a", kind: "text", content: source("one") },
          { path: "a/b.tex", kind: "text", content: source("two") },
        ],
        [
          {
            path: "main.tex",
            kind: "text",
            content: encodeSource(new Uint8Array([255])),
          },
        ],
        [
          {
            path: "large.pdf",
            kind: "binary",
            content: encodeSource(new Uint8Array(maxSourceFileBytes + 1)),
          },
        ],
      ] satisfies {
        path: string;
        kind: "text" | "binary";
        content: string;
      }[][]) {
        await assert.rejects(
          importProjectFiles({
            db,
            bucket,
            ownerId,
            data: { name: "Rejected upload", files },
          }),
        );
        assert.equal(
          (
            await db
              .select()
              .from(project)
              .where(
                and(
                  eq(project.ownerId, ownerId),
                  eq(project.name, "Rejected upload"),
                ),
              )
          ).length,
          0,
        );
      }
      let writes = 0;
      await assert.rejects(
        importProjectFiles({
          db,
          ownerId,
          bucket: {
            get: bucket.get.bind(bucket),
            list: bucket.list.bind(bucket),
            delete: bucket.delete.bind(bucket),
            put: async (...args) => {
              if (++writes === 2) throw new Error("Storage unavailable");
              return bucket.put(...args);
            },
          },
          data: {
            name: "Storage rollback",
            files: [
              { path: "main.tex", kind: "text", content: source("one") },
              { path: "other.tex", kind: "text", content: source("two") },
            ],
          },
        }),
        /Storage unavailable/,
      );
      assert.equal(
        (
          await db
            .select()
            .from(project)
            .where(
              and(
                eq(project.ownerId, ownerId),
                eq(project.name, "Storage rollback"),
              ),
            )
        ).length,
        0,
      );
      await saveProjectSource({
        db,
        bucket,
        userId: ownerId,
        data: {
          projectId: imported.id,
          nodeId: intro.id,
          expectedObjectKey: intro.objectKey,
          content: source("Updated nested chapter."),
        },
      });
      await checkLifecycle({
        db,
        bucket,
        collaboration: env.COLLABORATION,
        ownerId,
        viewerId,
        editorId,
        strangerId,
        organizationId,
        projectId: imported.id,
        orgProjectId: orgProject.id,
      });
      console.info(
        "Projects integration passed: private label isolation and revocation, role-aware actions, organization people, nested text/binary uploads, invalid paths/collisions/UTF-8/size, atomic storage failure rollback, trash, restore, retention, duplication, and ownership transfer",
      );
    } finally {
      await db.delete(organization).where(eq(organization.id, organizationId));
      for (const id of [ownerId, viewerId, editorId, strangerId])
        await db.delete(user).where(eq(user.id, id));
      await db.$client.end();
    }
    return new Response("Projects integration passed");
  },
};

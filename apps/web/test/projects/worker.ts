import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  tag,
  user,
} from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";

import { importProjectFiles } from "../../src/lib/project-import.server";
import { projectPaths } from "../../src/lib/project-paths";
import { encodeSource, maxSourceFileBytes } from "../../src/lib/project-source";
import {
  saveProjectSource,
  readProjectSource,
} from "../../src/lib/project-source.server";
import { projectTagsSchema } from "../../src/lib/project.schema";
import {
  createProject,
  deleteProject,
  getProjects,
  renameProject,
  setProjectTags,
} from "../../src/lib/project.server";

export { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration";

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
      assert.deepEqual((await getProjects({ db, ownerId }))[0]?.tags, [
        "draft",
        "research",
      ]);
      const viewer = (await getProjects({ db, ownerId: viewerId }))[0];
      assert(viewer);
      assert.deepEqual(viewer.tags, ["private", "research"]);
      assert.equal(viewer.canWrite, false);
      assert.equal(viewer.canDelete, false);
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
        (await getProjects({ db, ownerId: viewerId }))[0]?.tags,
        ["private", "research"],
      );
      assert.equal(
        (await getProjects({ db, ownerId: viewerId }))[0]?.updatedAt.getTime(),
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
        (await getProjects({ db, ownerId }))[0]?.name,
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
      assert.equal((await getProjects({ db, ownerId: viewerId })).length, 0);

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
        (await getProjects({ db, ownerId })).find(
          (item) => item.id === orgProject.id,
        )?.canDelete,
        true,
      );
      const orgMember = (await getProjects({ db, ownerId: editorId })).find(
        (item) => item.id === orgProject.id,
      );
      assert(orgMember?.canWrite && !orgMember.canDelete);
      assert.equal(orgMember.people.length, 2);

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
      await deleteProject({ db, ownerId, projectId: imported.id });
      console.info(
        "Projects integration passed: private label isolation and revocation, role-aware actions, organization people, nested text/binary uploads, invalid paths/collisions/UTF-8/size, and atomic storage failure rollback",
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

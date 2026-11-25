import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  projectNode,
  template,
  user,
} from "@texfolia/db/schema";
import { seedTemplates } from "@texfolia/db/seed-templates";
import { templateStarters } from "@texfolia/db/template-starters";
import { eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { encodeSource } from "#/lib/storage";
import { type SourceBucket, sweepProjectSources } from "#/lib/storage/server";
import { publishTemplateSchema, templateSnapshotSchema } from "#/lib/templates";
import {
  collectTemplateObjects,
  findTemplate,
  getTemplate,
  listTemplates,
  openTemplate,
  publishTemplate as publishTemplateSnapshot,
  refreshTemplatePreview,
  refreshTemplatePreviews,
  reportTemplate,
  reviewTemplate,
  templateArchive,
  templateReviewQueue,
} from "#/lib/templates/server";

import { createProjectNode } from "../../src/lib/projects/project-node.server";
import { saveProjectSource } from "../../src/lib/projects/project-source.server";
import {
  createProject,
  deleteTrashedProject,
  getProject,
  getProjects,
  trashProject,
} from "../../src/lib/projects/project.server";
import { lockProject } from "../../src/lib/sharing/project-access.server";

const publishTemplate = (
  options: Omit<Parameters<typeof publishTemplateSnapshot>[0], "lock">,
) => publishTemplateSnapshot({ ...options, lock: lockProject });

export { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration.server";
import { collectProjectSources } from "../collection";

export default {
  async fetch(_request: Request, env: Env) {
    const db = createDb(env.HYPERDRIVE.connectionString);
    const bucket = env.SOURCES;
    const publisherId = crypto.randomUUID();
    const viewerId = crypto.randomUUID();
    const editorId = crypto.randomUUID();
    const reviewerId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const sourceText =
      "\\documentclass{article}\n\\begin{document}Original é snapshot\\end{document}";
    const encode = (text: string) =>
      encodeSource(new TextEncoder().encode(text));
    const png = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const submissions = new Map<string, unknown>();
    const failedJobs = new Set<string>();
    const submittedTo = new Map<string, string>();
    const cleared: string[] = [];
    let seededIds: string[] = [];
    let serviceDown = false;
    const builds = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (serviceDown)
          return new Response("Temporarily unavailable", { status: 503 });
        // Previews compile in a temporary project named by the template ID.
        const match = new URL(request.url).pathname.match(
          /^\/projects\/([^/]+)(\/.*)$/,
        );
        if (!match) throw new Error(`Unexpected builds path ${request.url}`);
        const [, projectId, path] = match as unknown as [
          string,
          string,
          string,
        ];
        if (path === "/compile" && request.method === "POST") {
          const id = request.headers.get("X-Compilation-Id");
          assert(
            id && !submissions.has(id),
            "An attempt should compile only once",
          );
          assert.equal(request.headers.get("X-Compile-Plan"), "pro");
          assert.equal(
            request.headers.get("X-Compile-User"),
            `template-preview:${projectId}`,
          );
          submissions.set(id, await request.json());
          submittedTo.set(id, projectId);
          return Response.json({ status: "queued" }, { status: 202 });
        }
        if (path === "/build" && request.method === "DELETE") {
          cleared.push(projectId);
          return new Response(null, { status: 204 });
        }
        if (path.startsWith("/jobs/")) {
          const id = path.slice(6);
          return submittedTo.get(id) === projectId
            ? Response.json({
                status: failedJobs.has(id) ? "failed" : "succeeded",
              })
            : new Response(null, { status: 404 });
        }
        if (path.startsWith("/compilations/") && path.endsWith(".png")) {
          assert.equal(
            submittedTo.get(path.slice("/compilations/".length, -4)),
            projectId,
          );
          return new Response(png, {
            headers: { "Content-Type": "image/png" },
          });
        }
        throw new Error(`Unexpected builds path ${request.url}`);
      },
    } satisfies Pick<Fetcher, "fetch">;
    const refresh = async (templateId: string) => {
      await db
        .update(template)
        .set({ previewNextAttemptAt: new Date(0) })
        .where(eq(template.id, templateId));
      await refreshTemplatePreviews({ db, bucket, builds, templateId });
    };

    try {
      for (const id of [publisherId, viewerId, editorId, reviewerId])
        await db.insert(user).values({
          id,
          name: "Template test publisher",
          email: `${id}@example.com`,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db.insert(organization).values({
        id: organizationId,
        name: "Template test team",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(member).values([
        {
          id: crypto.randomUUID(),
          organizationId,
          userId: viewerId,
          role: "admin",
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
      const original = await createProject({
        db,
        ownerId: publisherId,
        data: {
          id: crypto.randomUUID(),
          name: `Template source ${crypto.randomUUID()}`,
        },
      });
      const originalProject = await getProject({
        db,
        bucket,
        ownerId: publisherId,
        projectId: original.id,
      });
      const main = originalProject.nodes.find(
        (node) => node.name === "main.tex",
      );
      const root = originalProject.nodes.find((node) => node.parentId === null);
      assert(main && root);
      const saved = await saveProjectSource({
        db,
        bucket,
        userId: publisherId,
        data: {
          projectId: original.id,
          nodeId: main.id,
          expectedObjectKey: null,
          content: encode(sourceText),
        },
      });
      const folder = await createProjectNode({
        db,
        bucket,
        ownerId: publisherId,
        data: {
          id: crypto.randomUUID(),
          projectId: original.id,
          parentId: root.id,
          name: "assets",
          kind: "folder",
        },
      });
      const binary = await createProjectNode({
        db,
        bucket,
        ownerId: publisherId,
        data: {
          id: crypto.randomUUID(),
          projectId: original.id,
          parentId: folder.id,
          name: "data.bin",
          kind: "binary",
          content: "AAEC/w==",
        },
      });
      await db.insert(projectCollaborator).values([
        { projectId: original.id, userId: viewerId, role: "viewer" },
        { projectId: original.id, userId: editorId, role: "editor" },
      ]);
      const data = publishTemplateSchema.parse({
        projectId: original.id,
        title: "Original article",
        description: "An independent snapshot for testing",
        tags: ["Article", "article"],
        license: "CC0-1.0",
        visibility: "public",
        redistributionConfirmed: true,
      });
      assert.deepEqual(data.tags, ["article"]);
      assert(
        !publishTemplateSchema.safeParse({ ...data, license: undefined })
          .success,
      );
      assert(
        !publishTemplateSchema.safeParse({
          ...data,
          redistributionConfirmed: false,
        }).success,
      );
      for (const userId of [viewerId, editorId])
        await assert.rejects(
          publishTemplate({ db, bucket, userId, data }),
          /Only the project owner/,
        );
      const invalidTemplateId = crypto.randomUUID();
      await db
        .update(projectNode)
        .set({ name: "data:1.bin" })
        .where(eq(projectNode.id, binary.id));
      await assert.rejects(
        publishTemplate({
          db,
          bucket,
          userId: publisherId,
          data,
          templateId: invalidTemplateId,
        }),
        /Repair source paths/,
      );
      assert.equal(
        (
          await bucket.list({
            prefix: `templates/${invalidTemplateId}/sources/`,
          })
        ).objects.length,
        0,
      );
      assert.deepEqual(
        await db
          .select({ id: template.id })
          .from(template)
          .where(eq(template.id, invalidTemplateId)),
        [],
      );
      await db
        .update(projectNode)
        .set({ name: "data.bin" })
        .where(eq(projectNode.id, binary.id));
      const published = await publishTemplate({
        db,
        bucket,
        userId: publisherId,
        data,
      });
      assert.equal(await getTemplate({ db, templateId: published.id }), null);
      assert.equal(
        (
          await getTemplate({
            db,
            templateId: published.id,
            userId: publisherId,
          })
        )?.status,
        "pending",
      );
      assert(
        !(await listTemplates({ db })).some((item) => item.id === published.id),
      );
      await assert.rejects(
        openTemplate({
          db,
          bucket,
          userId: viewerId,
          data: { templateId: published.id, organizationId: null },
        }),
        /Template not found/,
      );
      serviceDown = true;
      await refresh(published.id);
      assert.equal(
        (
          await getTemplate({
            db,
            templateId: published.id,
            userId: publisherId,
          })
        )?.status,
        "pending",
      );
      serviceDown = false;
      await refresh(published.id);
      const firstAttempt = (
        await findTemplate({
          db,
          templateId: published.id,
          userId: publisherId,
        })
      )?.previewJobId;
      assert(firstAttempt);
      // The submission names saved snapshot objects and copies no bytes.
      const submitted = z
        .object({
          mainFile: z.literal("main.tex"),
          preview: z.literal(true),
          files: z.record(
            z.string(),
            z.object({ hash: z.string(), size: z.number(), key: z.string() }),
          ),
        })
        .parse(submissions.get(firstAttempt));
      assert.deepEqual(Object.keys(submitted.files).sort(), [
        "assets/data.bin",
        "main.tex",
      ]);
      for (const [path, expected] of [
        ["main.tex", new TextEncoder().encode(sourceText)],
        ["assets/data.bin", new Uint8Array([0, 1, 2, 255])],
      ] as const) {
        const file = submitted.files[path];
        assert.equal(
          file?.key,
          `templates/${published.id}/sources/${file?.hash}`,
        );
        assert.equal(file.size, expected.length);
        const object = await bucket.get(file.key);
        assert(object);
        assert.deepEqual(new Uint8Array(await object.arrayBuffer()), expected);
      }
      await refresh(published.id);
      assert.equal(
        (
          await getTemplate({
            db,
            templateId: published.id,
            userId: publisherId,
          })
        )?.status,
        "pending",
      );
      await assert.rejects(
        templateReviewQueue({ db, userId: viewerId, reviewers: reviewerId }),
        /Not authorized/,
      );
      await assert.rejects(
        reviewTemplate({
          db,
          userId: publisherId,
          reviewers: publisherId,
          templateId: published.id,
          decision: "approved",
        }),
        /Another reviewer/,
      );
      assert(
        (
          await templateReviewQueue({
            db,
            userId: reviewerId,
            reviewers: reviewerId,
          })
        ).pending.some((item) => item.id === published.id),
      );
      await reviewTemplate({
        db,
        userId: reviewerId,
        reviewers: reviewerId,
        templateId: published.id,
        decision: "approved",
      });
      assert(
        (await listTemplates({ db })).some((item) => item.id === published.id),
      );
      const exposed = await getTemplate({ db, templateId: published.id });
      assert(exposed && !("snapshot" in exposed) && !("ownerId" in exposed));
      const found = await findTemplate({ db, templateId: published.id });
      assert(found?.previewKey);
      assert.deepEqual(
        new Uint8Array(
          await (await bucket.get(found.previewKey))!.arrayBuffer(),
        ),
        png,
      );
      const snapshot = templateSnapshotSchema.parse(found.snapshot);
      const invalidSnapshot = snapshot.map((node) =>
        node.name === "data.bin" ? { ...node, name: "data:1.bin" } : node,
      );
      await db
        .update(template)
        .set({ snapshot: invalidSnapshot })
        .where(eq(template.id, published.id));
      const projectsBeforeInvalid = (
        await getProjects({ db, userId: editorId })
      ).projects.length;
      await assert.rejects(
        openTemplate({
          db,
          bucket,
          userId: editorId,
          data: { templateId: published.id, organizationId: null },
        }),
        /Repair source paths/,
      );
      assert.equal(
        (await getProjects({ db, userId: editorId })).projects.length,
        projectsBeforeInvalid,
      );
      await db
        .update(template)
        .set({ snapshot })
        .where(eq(template.id, published.id));
      const binarySnapshot = snapshot.find((node) => node.name === "data.bin");
      assert(binarySnapshot?.objectKey);
      const beforeFailure = (await getProjects({ db, userId: editorId }))
        .projects.length;
      await bucket.delete(binarySnapshot.objectKey);
      await assert.rejects(
        openTemplate({
          db,
          bucket,
          userId: editorId,
          data: { templateId: published.id, organizationId: null },
        }),
        /Source is missing/,
      );
      assert.equal(
        (await getProjects({ db, userId: editorId })).projects.length,
        beforeFailure,
      );
      await bucket.put(
        binarySnapshot.objectKey,
        new Uint8Array([0, 1, 2, 255]),
      );
      const orphanId = crypto.randomUUID();
      const orphanKey = `templates/${orphanId}/sources/${"0".repeat(64)}`;
      await bucket.put(orphanKey, "orphan");
      await collectTemplateObjects({ db, bucket });
      assert(await bucket.get(orphanKey));
      await collectTemplateObjects({
        db,
        bucket,
        olderThan: new Date(Date.now() + 60_000),
      });
      assert.equal(await bucket.get(orphanKey), null);
      assert(await bucket.get(binarySnapshot.objectKey));
      assert(
        snapshot
          .filter((node) => node.kind !== "folder")
          .every((node) =>
            node.objectKey?.startsWith(`templates/${published.id}/sources/`),
          ),
      );
      assert(
        (await new Response(templateArchive({ bucket, found })).arrayBuffer())
          .byteLength > sourceText.length,
      );

      const uploaded = Promise.withResolvers<void>();
      const releaseCopy = Promise.withResolvers<void>();
      let paused = false;
      const pausingBucket: SourceBucket = {
        get: bucket.get.bind(bucket),
        list: bucket.list.bind(bucket),
        delete: bucket.delete.bind(bucket),
        put: async (...args: Parameters<SourceBucket["put"]>) => {
          const result = await bucket.put(...args);
          if (!paused) {
            paused = true;
            uploaded.resolve();
            await releaseCopy.promise;
          }
          return result;
        },
      };
      const copying = openTemplate({
        db,
        bucket: pausingBucket,
        userId: editorId,
        data: { templateId: published.id, organizationId: null },
      });
      await uploaded.promise;
      // The copy waits for storage without a transaction, so this runs meanwhile.
      // It leaves recent uploads alone until the project refers to them.
      await sweepProjectSources({ db, bucket });
      releaseCopy.resolve();
      const racedCopy = await copying;
      const preserved = await getProject({
        db,
        bucket,
        ownerId: editorId,
        projectId: racedCopy.id,
      });
      assert(Object.values(preserved.sourceContents).includes(sourceText));

      await saveProjectSource({
        db,
        bucket,
        userId: publisherId,
        data: {
          projectId: original.id,
          nodeId: main.id,
          expectedObjectKey: saved.objectKey,
          content: encode("changed original"),
        },
      });
      const trashed = { db, userId: publisherId, projectId: original.id };
      await trashProject(trashed);
      await deleteTrashedProject(trashed);
      await collectProjectSources({
        db,
        bucket,
        collaboration: env.COLLABORATION,
      });
      assert.equal(await bucket.get(saved.objectKey), null);
      const personal = await openTemplate({
        db,
        bucket,
        userId: viewerId,
        data: { templateId: published.id, organizationId: null },
      });
      const team = await openTemplate({
        db,
        bucket,
        userId: viewerId,
        data: { templateId: published.id, organizationId },
      });
      const copy = await getProject({
        db,
        bucket,
        ownerId: viewerId,
        projectId: personal.id,
      });
      const copiedMain = copy.nodes.find((node) => node.name === "main.tex");
      const copiedBinary = copy.nodes.find((node) => node.name === "data.bin");
      assert(
        copiedMain &&
          copiedBinary &&
          copiedMain.id !== main.id &&
          copiedBinary.id !== binary.id,
      );
      assert.equal(copy.sourceContents[copiedMain.id], sourceText);
      assert(
        copy.nodes.every(
          (node) =>
            node.projectId === personal.id &&
            !snapshot.some((item) => item.id === node.id),
        ),
      );
      const copiedBinaryRow = await db.query.projectNode.findFirst({
        where: { id: copiedBinary.id },
      });
      assert(copiedBinaryRow?.objectKey);
      assert(
        copiedBinaryRow.objectKey.startsWith(
          `projects/${personal.id}/sources/`,
        ),
      );
      assert.deepEqual(
        new Uint8Array(
          await (await bucket.get(copiedBinaryRow.objectKey))!.arrayBuffer(),
        ),
        new Uint8Array([0, 1, 2, 255]),
      );
      assert.equal(
        (
          await getProject({
            db,
            bucket,
            ownerId: editorId,
            projectId: team.id,
          })
        ).organizationId,
        organizationId,
      );
      assert(
        (await getProjects({ db, userId: editorId })).projects.some(
          (item) => item.id === team.id,
        ),
      );
      await assert.rejects(
        openTemplate({
          db,
          bucket,
          userId: publisherId,
          data: { templateId: published.id, organizationId },
        }),
        /Organization not found/,
      );
      await assert.rejects(
        getProject({ db, bucket, ownerId: publisherId, projectId: team.id }),
        /Project not found/,
      );
      await assert.rejects(
        trashProject({ db, userId: editorId, projectId: team.id }),
        /Only organization/,
      );
      await assert.rejects(
        publishTemplate({
          db,
          bucket,
          userId: editorId,
          data: { ...data, projectId: team.id },
        }),
        /Only organization/,
      );
      const unlisted = await publishTemplate({
        db,
        bucket,
        userId: viewerId,
        data: { ...data, projectId: team.id, visibility: "unlisted" },
      });
      await refresh(unlisted.id);
      await refresh(unlisted.id);
      await reviewTemplate({
        db,
        userId: reviewerId,
        reviewers: reviewerId,
        templateId: unlisted.id,
        decision: "approved",
      });
      assert(await getTemplate({ db, templateId: unlisted.id }));
      assert(
        !(await listTemplates({ db })).some((item) => item.id === unlisted.id),
      );
      assert.equal(
        (await getTemplate({ db, templateId: unlisted.id }))?.publisherName,
        "Template test team",
      );
      await db.delete(member).where(eq(member.userId, viewerId));
      await assert.rejects(
        getProject({ db, bucket, ownerId: viewerId, projectId: team.id }),
        /Project not found/,
      );
      assert(
        !(await getProjects({ db, userId: viewerId })).projects.some(
          (item) => item.id === team.id,
        ),
      );

      const next = await publishTemplate({
        db,
        bucket,
        userId: publisherId,
        data: { ...data, projectId: personal.id },
      }).then(
        () => {
          throw new Error("Cannot publish another user's personal project");
        },
        (error: unknown) => {
          assert(
            error instanceof Error &&
              error.message.includes("Project not found"),
          );
        },
      );
      assert.equal(next, undefined);
      const republished = await publishTemplate({
        db,
        bucket,
        userId: viewerId,
        data: { ...data, projectId: personal.id },
      });
      const retryAs = (userId?: string) =>
        refreshTemplatePreview({
          db,
          bucket,
          builds,
          templateId: republished.id,
          retry: true,
          userId,
          reviewers: reviewerId,
        });
      const retrySource = await findTemplate({
        db,
        templateId: republished.id,
        userId: viewerId,
      });
      assert(retrySource);
      failedJobs.add(retrySource.previewJobId);
      await refresh(republished.id);
      await refresh(republished.id);
      assert.equal(
        (
          await findTemplate({
            db,
            templateId: republished.id,
            userId: viewerId,
          })
        )?.previewStatus,
        "failed",
      );
      assert.equal(
        cleared.filter((id) => id === republished.id).length,
        1,
        "A failed attempt clears its temporary project",
      );
      await assert.rejects(retryAs(viewerId), /Wait a minute/);

      assert.equal(
        (
          await getTemplate({
            db,
            templateId: republished.id,
            userId: viewerId,
          })
        )?.status,
        "pending",
      );
      await reviewTemplate({
        db,
        templateId: republished.id,
        userId: reviewerId,
        reviewers: reviewerId,
        decision: "approved",
      });
      await db
        .update(template)
        .set({ previewStartedAt: new Date(Date.now() - 61_000) })
        .where(eq(template.id, republished.id));
      for (const userId of [undefined, editorId])
        await assert.rejects(
          retryAs(userId),
          /Template not found/,
          "Only the owner or a reviewer can retry a preview",
        );
      const retries = await Promise.allSettled([
        retryAs(viewerId),
        retryAs(reviewerId),
      ]);
      assert.equal(
        retries.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const newAttempt = await findTemplate({ db, templateId: republished.id });
      assert(
        newAttempt && newAttempt.previewJobId !== retrySource.previewJobId,
      );
      assert.deepEqual(newAttempt.snapshot, retrySource.snapshot);
      await refresh(republished.id);
      await refresh(republished.id);
      assert.equal(
        (await getTemplate({ db, templateId: republished.id }))?.previewStatus,
        "ready",
      );
      assert.equal(
        cleared.filter((id) => id === republished.id).length,
        2,
        "A ready attempt clears its temporary project",
      );
      assert.equal(
        (await getTemplate({ db, templateId: republished.id }))?.status,
        "approved",
      );
      const concurrent = await Promise.allSettled(
        [1, 2].map(() =>
          publishTemplate({
            db,
            bucket,
            userId: viewerId,
            data: { ...data, projectId: personal.id },
          }),
        ),
      );
      assert.equal(
        concurrent.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert(
        concurrent.some(
          (result) =>
            result.status === "rejected" &&
            String(result.reason).includes("Publishing limit reached"),
        ),
      );
      await reportTemplate({
        db,
        userId: editorId,
        templateId: published.id,
        reason: "Please review the included license notices.",
      });
      await reportTemplate({
        db,
        userId: editorId,
        templateId: published.id,
        reason: "Duplicate report",
      });
      assert.equal(
        (
          await templateReviewQueue({
            db,
            userId: reviewerId,
            reviewers: reviewerId,
          })
        ).reports.filter((report) => report.templateId === published.id).length,
        1,
      );
      await reviewTemplate({
        db,
        userId: reviewerId,
        reviewers: reviewerId,
        templateId: published.id,
        decision: "rejected",
      });
      assert.equal(await getTemplate({ db, templateId: published.id }), null);
      await assert.rejects(
        openTemplate({
          db,
          bucket,
          userId: editorId,
          data: { templateId: published.id, organizationId: null },
        }),
        /Template not found/,
      );
      assert.equal(
        (
          await getProject({
            db,
            bucket,
            ownerId: viewerId,
            projectId: personal.id,
          })
        ).sourceContents[copiedMain.id],
        sourceText,
      );
      assert.equal(submissions.size, 4);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
      await db
        .update(template)
        .set({ createdAt: twoHoursAgo })
        .where(eq(template.ownerId, viewerId));
      for (let index = 0; index < 7; index++) {
        const additional = await publishTemplate({
          db,
          bucket,
          userId: viewerId,
          data: { ...data, projectId: personal.id },
        });
        await db
          .update(template)
          .set({ createdAt: twoHoursAgo })
          .where(eq(template.id, additional.id));
      }
      await assert.rejects(
        publishTemplate({
          db,
          bucket,
          userId: viewerId,
          data: { ...data, projectId: personal.id },
        }),
        /Publishing limit reached/,
      );
      const projectCount = (await db.select().from(project)).length;
      let partialUploads = 0;
      await assert.rejects(
        seedTemplates({
          db,
          putSource: async (key, bytes) => {
            if (++partialUploads === 2)
              throw new Error("Interrupted seed upload");
            await bucket.put(key, bytes);
          },
        }),
        /Interrupted seed upload/,
      );
      assert.equal(
        (await db.select().from(template).where(isNull(template.ownerId)))
          .length,
        0,
        "An incomplete seed is not published",
      );
      const concurrentSeeds = await Promise.all(
        [1, 2].map(() =>
          seedTemplates({
            db,
            putSource: (key, bytes) => bucket.put(key, bytes),
          }),
        ),
      );
      const seeds = concurrentSeeds[0];
      assert(seeds);
      assert.deepEqual(concurrentSeeds[1], seeds);
      seededIds = seeds.map((item) => item.id);
      assert.equal(seeds.length, 3);
      assert.deepEqual(
        await seedTemplates({
          db,
          putSource: (key, bytes) => bucket.put(key, bytes),
        }),
        seeds,
      );
      assert.equal(
        (await db.select().from(project)).length,
        projectCount,
        "Seeds do not create projects",
      );
      for (const seeded of seeds) {
        const stored = await findTemplate({
          db,
          templateId: seeded.id,
          userId: reviewerId,
        });
        assert(
          stored &&
            stored.license === "CC0-1.0" &&
            stored.ownerId === null &&
            stored.status === "approved",
        );
        const originalStarter = templateStarters.find(
          (starter) => starter.title === seeded.title,
        );
        assert(originalStarter);
        assert.deepEqual(stored.tags, originalStarter.tags);
        const files = templateSnapshotSchema.parse(stored.snapshot);
        const main = files.find((node) => node.name === "main.tex");
        assert(main?.objectKey);
        assert.equal(
          await (await bucket.get(main.objectKey))!.text(),
          originalStarter.source,
        );
        const license = files.find((node) => node.name === "LICENSE.txt");
        assert(license?.objectKey);
        assert(
          (await (await bucket.get(license.objectKey))!.text()).includes(
            "CC0-1.0",
          ),
        );
      }
      const retainedCopy = await openTemplate({
        db,
        bucket,
        userId: editorId,
        data: { templateId: seeds[0]!.id, organizationId: null },
      });
      assert.equal(
        (
          await getProject({
            db,
            bucket,
            ownerId: editorId,
            projectId: retainedCopy.id,
          })
        ).name,
        "Simple article",
      );
      const namedCopies = await Promise.all(
        [1, 2].map(() =>
          openTemplate({
            db,
            bucket,
            userId: editorId,
            data: { templateId: seeds[0]!.id, organizationId: null },
          }),
        ),
      );
      const names = await Promise.all(
        namedCopies.map((item) =>
          getProject({
            db,
            bucket,
            ownerId: editorId,
            projectId: item.id,
          }).then((item) => item.name),
        ),
      );
      assert.deepEqual(names.sort(), [
        "Simple article (2)",
        "Simple article (3)",
      ]);
      await db.delete(user).where(eq(user.id, viewerId));
      assert.equal(await getTemplate({ db, templateId: unlisted.id }), null);
      await collectTemplateObjects({
        db,
        bucket,
        olderThan: new Date(Date.now() + 60_000),
      });
      assert.equal(
        (await bucket.list({ prefix: `templates/${unlisted.id}/` })).objects
          .length,
        0,
      );
      assert(
        await getTemplate({ db, templateId: seeds[0]!.id }),
        "Curated templates have no account dependency",
      );
      assert.equal(
        (
          await getProject({
            db,
            bucket,
            ownerId: editorId,
            projectId: team.id,
          })
        ).organizationId,
        organizationId,
      );
      return new Response(
        "Template integration passed: real Postgres/local R2, immutable snapshots, text/binary/tree copies, source deletion, personal/org access and revocation, licenses, concurrent publishing limits, unlisted visibility, preview persistence, snapshot review, reports and rejection.",
      );
    } finally {
      if (seededIds.length)
        await db.delete(template).where(inArray(template.id, seededIds));
      await db.delete(organization).where(eq(organization.id, organizationId));
      for (const id of [publisherId, viewerId, editorId, reviewerId])
        await db.delete(user).where(eq(user.id, id));
      await db.$client.end();
    }
  },
} satisfies ExportedHandler<Env>;

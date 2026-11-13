import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  member,
  organization,
  projectCollaborator,
  template,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";

import { createProjectNode } from "../src/lib/project-node.server";
import { encodeSource } from "../src/lib/project-source";
import {
  collectProjectSources,
  saveProjectSource,
  type SourceBucket,
} from "../src/lib/project-source.server";
import {
  createProject,
  deleteProject,
  getProject,
  getProjects,
} from "../src/lib/project.server";
import { seedTemplateStarters } from "../src/lib/template-seed.server";
import {
  publishTemplateSchema,
  templateSnapshotSchema,
} from "../src/lib/template.schema";
import {
  collectTemplateObjects,
  findTemplate,
  getTemplate,
  listTemplates,
  openTemplate,
  publishTemplate,
  refreshTemplatePreviews,
  reportTemplate,
  reviewTemplate,
  templateArchive,
  templateReviewQueue,
} from "../src/lib/template.server";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres database with 'test' in its name",
);
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
  connectionString;
const directory = await mkdtemp(join(tmpdir(), "texfolia-templates-"));
const platform = await getPlatformProxy<{ SOURCES: SourceBucket }>({
  configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
  envFiles: [],
  persist: { path: directory },
  remoteBindings: false,
});
const db = createDb(connectionString);
const bucket = platform.env.SOURCES;
const publisherId = crypto.randomUUID();
const viewerId = crypto.randomUUID();
const editorId = crypto.randomUUID();
const reviewerId = crypto.randomUUID();
const organizationId = crypto.randomUUID();
const sourceText =
  "\\documentclass{article}\n\\begin{document}Original é snapshot\\end{document}";
const encode = (text: string) => encodeSource(new TextEncoder().encode(text));
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
    "base64",
  ),
);
const submissions = new Map<string, unknown>();
let serviceDown = false;
const compiler = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (serviceDown)
      return new Response("Temporarily unavailable", { status: 503 });
    const path = new URL(request.url).pathname;
    if (path === "/compile") {
      const id = request.headers.get("X-Compilation-Id");
      assert(id && !submissions.has(id), "A snapshot should compile only once");
      submissions.set(id, await request.json());
      return Response.json({ status: "queued" }, { status: 202 });
    }
    if (path.startsWith("/jobs/"))
      return submissions.has(path.slice(6))
        ? Response.json({ status: "succeeded" })
        : new Response(null, { status: 404 });
    if (path.endsWith(".png"))
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    throw new Error(`Unexpected compiler path ${path}`);
  },
} satisfies Pick<Fetcher, "fetch">;
const refresh = (templateId: string) =>
  refreshTemplatePreviews({ db, bucket, compiler, templateId });

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
  const main = originalProject.nodes.find((node) => node.name === "main.tex");
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
    !publishTemplateSchema.safeParse({ ...data, license: undefined }).success,
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
  const published = await publishTemplate({
    db,
    bucket,
    userId: publisherId,
    data,
  });
  assert.equal(await getTemplate({ db, templateId: published.id }), null);
  assert.equal(
    (await getTemplate({ db, templateId: published.id, userId: publisherId }))
      ?.status,
    "building",
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
    (await getTemplate({ db, templateId: published.id, userId: publisherId }))
      ?.status,
    "building",
  );
  serviceDown = false;
  await refresh(published.id);
  assert.deepEqual(submissions.get(published.id), {
    mainFile: "main.tex",
    preview: true,
    files: {
      "main.tex": sourceText,
      "assets/data.bin": { base64: "AAEC/w==" },
    },
  });
  await refresh(published.id);
  assert.equal(
    (await getTemplate({ db, templateId: published.id, userId: publisherId }))
      ?.status,
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
    new Uint8Array(await (await bucket.get(found.previewKey))!.arrayBuffer()),
    png,
  );
  const snapshot = templateSnapshotSchema.parse(found.snapshot);
  const binarySnapshot = snapshot.find((node) => node.name === "data.bin");
  assert(binarySnapshot?.objectKey);
  const beforeFailure = (await getProjects({ db, ownerId: editorId })).length;
  await bucket.delete(binarySnapshot.objectKey);
  await assert.rejects(
    openTemplate({
      db,
      bucket,
      userId: editorId,
      data: { templateId: published.id, organizationId: null },
    }),
    /Snapshot source is missing/,
  );
  assert.equal(
    (await getProjects({ db, ownerId: editorId })).length,
    beforeFailure,
  );
  await bucket.put(binarySnapshot.objectKey, new Uint8Array([0, 1, 2, 255]));
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
  assert((await templateArchive({ bucket, found })).size > sourceText.length);

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
  const collecting = collectProjectSources({ db, bucket });
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      const { rows } = await db.$client.query<{ waiting: boolean }>(
        "select exists(select 1 from pg_locks where locktype = 'advisory' and not granted) as waiting",
      );
      if (rows[0]?.waiting) break;
      assert(
        Date.now() < deadline,
        "Source collection must wait for an uncommitted template copy",
      );
      await Bun.sleep(10);
    }
  } finally {
    releaseCopy.resolve();
  }
  const racedCopy = await copying;
  await collecting;
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
  await deleteProject({ db, ownerId: publisherId, projectId: original.id });
  await collectProjectSources({ db, bucket });
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
    copiedBinaryRow.objectKey.startsWith(`projects/${personal.id}/sources/`),
  );
  assert.deepEqual(
    new Uint8Array(
      await (await bucket.get(copiedBinaryRow.objectKey))!.arrayBuffer(),
    ),
    new Uint8Array([0, 1, 2, 255]),
  );
  assert.equal(
    (await getProject({ db, bucket, ownerId: editorId, projectId: team.id }))
      .organizationId,
    organizationId,
  );
  assert(
    (await getProjects({ db, ownerId: editorId })).some(
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
    deleteProject({ db, ownerId: editorId, projectId: team.id }),
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
    !(await getProjects({ db, ownerId: viewerId })).some(
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
        error instanceof Error && error.message.includes("Project not found"),
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
  await refresh(republished.id);
  await refresh(republished.id);
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
  assert.equal(submissions.size, 3);
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
  await assert.rejects(
    seedTemplateStarters({
      db,
      bucket,
      userId: publisherId,
      reviewers: reviewerId,
    }),
    /Not authorized/,
  );
  const seeds = await seedTemplateStarters({
    db,
    bucket,
    userId: reviewerId,
    reviewers: reviewerId,
  });
  assert.equal(seeds.length, 3);
  assert.deepEqual(
    await seedTemplateStarters({
      db,
      bucket,
      userId: reviewerId,
      reviewers: reviewerId,
    }),
    seeds,
  );
  for (const seeded of seeds) {
    const stored = await findTemplate({
      db,
      templateId: seeded.id,
      userId: reviewerId,
    });
    assert(stored && stored.license === "CC0-1.0");
    const files = templateSnapshotSchema.parse(stored.snapshot);
    const license = files.find((node) => node.name === "LICENSE.txt");
    assert(license?.objectKey);
    assert(
      (await (await bucket.get(license.objectKey))!.text()).includes("CC0-1.0"),
    );
  }
  await db.delete(user).where(eq(user.id, viewerId));
  assert.equal(
    (await getProject({ db, bucket, ownerId: editorId, projectId: team.id }))
      .organizationId,
    organizationId,
  );
  console.log(
    "Template integration passed: real Postgres/local R2, immutable snapshots, text/binary/tree copies, source deletion, personal/org access and revocation, licenses, concurrent publishing limits, unlisted visibility, preview persistence, new-publisher review, reports and rejection.",
  );
} finally {
  await db.delete(organization).where(eq(organization.id, organizationId));
  for (const id of [publisherId, viewerId, editorId, reviewerId])
    await db.delete(user).where(eq(user.id, id));
  await db.$client.end();
  await platform.dispose();
  await rm(directory, { recursive: true, force: true });
}

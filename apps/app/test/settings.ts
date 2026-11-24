import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import {
  aiSettings,
  member,
  organization,
  project,
  projectCollaborator,
  projectJob,
  projectNode,
  user,
} from "@texfolia/db/schema";
import { eq, inArray } from "drizzle-orm";

import { updateProjectFormattingSchema } from "#/lib/projects";

import {
  createProject,
  getProject,
  updateProjectFormatting,
} from "../src/lib/projects/project.server";
import {
  getAccountUsage,
  saveAccountAiSettings,
} from "../src/lib/settings/account-settings.server";

const connection = process.env.INTEGRATION_DATABASE_URL;
assert(
  connection && new URL(connection).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connection);
const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
const [owner, editor, viewer, outsider] = ids;
assert(owner && editor && viewer && outsider);
const orgId = crypto.randomUUID();
const personalId = crypto.randomUUID();
const orgProjectId = crypto.randomUUID();
try {
  await db.insert(user).values(
    ids.map((id) => ({
      id,
      name: "Settings test",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  await db.insert(organization).values({
    id: orgId,
    name: "Settings team",
    slug: orgId,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    userId: editor,
    organizationId: orgId,
    role: "member",
    createdAt: new Date(),
  });
  await createProject({
    db,
    ownerId: owner,
    data: { id: personalId, name: "Settings access" },
  });
  await db.insert(projectCollaborator).values([
    { projectId: personalId, userId: editor, role: "editor" },
    { projectId: personalId, userId: viewer, role: "viewer" },
  ]);
  const original = await getProject({
    db,
    ownerId: viewer,
    projectId: personalId,
  });
  assert.equal(original.canWrite, false);
  assert.equal(original.formatIndent, 2);
  assert.equal(original.formatWrap, true);
  assert.equal(original.formatWidth, 80);
  const first = { indent: 4, wrap: false, width: 120 };
  await updateProjectFormatting({
    db,
    ownerId: owner,
    data: { projectId: personalId, formatting: first },
  });
  const shared = await getProject({
    db,
    ownerId: viewer,
    projectId: personalId,
  });
  assert.deepEqual(
    [shared.formatIndent, shared.formatWrap, shared.formatWidth],
    [4, false, 120],
  );
  const second = { indent: 3, wrap: true, width: 90 };
  await updateProjectFormatting({
    db,
    ownerId: editor,
    data: { projectId: personalId, formatting: second },
  });
  for (const ownerId of [viewer, outsider])
    await assert.rejects(
      updateProjectFormatting({
        db,
        ownerId,
        data: { projectId: personalId, formatting: first },
      }),
      /Project not found/,
    );
  const unchanged = await getProject({
    db,
    ownerId: owner,
    projectId: personalId,
  });
  assert.equal(unchanged.formatIndent, 3);
  assert.equal(unchanged.formatWidth, 90);
  assert.equal(
    updateProjectFormattingSchema.safeParse({
      projectId: personalId,
      formatting: { ...first, width: 5 },
    }).success,
    false,
  );
  await db
    .insert(project)
    .values({ id: orgProjectId, organizationId: orgId, name: "Team settings" });
  await updateProjectFormatting({
    db,
    ownerId: editor,
    data: { projectId: orgProjectId, formatting: first },
  });
  assert.equal(
    (await getProject({ db, ownerId: editor, projectId: orgProjectId }))
      .formatIndent,
    4,
  );
  await assert.rejects(
    updateProjectFormatting({
      db,
      ownerId: owner,
      data: { projectId: orgProjectId, formatting: first },
    }),
    /Project not found/,
  );
  const root = await db.query.projectNode.findFirst({
    where: { projectId: personalId, parentId: { isNull: true } },
  });
  assert(root);
  await db.insert(projectNode).values({
    projectId: personalId,
    parentId: root.id,
    name: "sized.tex",
    kind: "text",
    objectKey: "fixture/source",
    sizeBytes: 123n,
  });
  await db.insert(projectJob).values([
    { projectId: personalId, status: "succeeded", sizeBytes: 0n },
    { projectId: personalId, status: "failed", sizeBytes: 0n },
  ]);
  await saveAccountAiSettings(db, owner, { kind: "cap", dollars: 12.34 });
  const usage = await getAccountUsage(db, owner);
  assert.equal(usage.sourceBytes, "123");
  assert.equal(usage.compiles.total, 2);
  assert.equal(usage.compiles.succeeded, 1);
  assert.equal(usage.compiles.failed, 1);
  assert.equal(usage.monthlyCapDollars, 12.34);
  await db
    .update(aiSettings)
    .set({ defaultModel: "existing-model" })
    .where(eq(aiSettings.userId, owner));
  await saveAccountAiSettings(db, owner, { kind: "cap", dollars: 0 });
  assert.equal(
    (await db.select().from(aiSettings).where(eq(aiSettings.userId, owner)))[0]
      ?.defaultModel,
    "existing-model",
  );
  console.info(
    "Settings integration passed: project defaults, owner/editor/viewer/outsider and organization access, shared reads, validation, source/compile totals, and independent AI cap updates",
  );
} finally {
  await db
    .delete(project)
    .where(inArray(project.id, [personalId, orgProjectId]));
  await db.delete(organization).where(eq(organization.id, orgId));
  await db.delete(user).where(inArray(user.id, ids));
  await db.$client.end();
}

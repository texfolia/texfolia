import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  user,
} from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";

import { createProjectNode } from "../src/features/projects/project-node.server";
import {
  createProject,
  getProject,
  getProjects,
  trashProject,
} from "../src/features/projects/project.server";
import { checkComments } from "./postgres/comments";
import { checkSharingNotifications } from "./postgres/sharing-notifications";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString,
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres test database",
);
assert(
  new URL(connectionString).pathname.includes("test"),
  "Use a database with 'test' in its name",
);
const db = createDb(connectionString);
const ownerId = crypto.randomUUID();
const teammateId = crypto.randomUUID();
const organizationId = crypto.randomUUID();

async function assertInaccessible({
  userId,
  projectId,
}: {
  userId: string;
  projectId: string;
}) {
  assert(
    !(await getProjects({ db, userId })).projects.some(
      (item) => item.id === projectId,
    ),
  );
  await assert.rejects(
    getProject({ db, ownerId: userId, projectId }),
    /Project not found/,
  );
}

try {
  await db.insert(user).values({
    id: ownerId,
    name: "Owner",
    email: `${ownerId}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const created = await createProject({
    db,
    ownerId,
    data: {
      id: crypto.randomUUID(),
      name: `Integration ${crypto.randomUUID()}`,
    },
  });
  const loaded = await getProject({ db, ownerId, projectId: created.id });
  const folder = loaded.nodes.find((node) => node.kind === "folder");
  assert(folder);
  assert(loaded.nodes.some((node) => node.name === "main.tex"));
  assert(
    (await getProjects({ db, userId: ownerId })).projects.some(
      (item) => item.id === created.id,
    ),
  );

  await db.insert(user).values({
    id: teammateId,
    name: "Teammate",
    email: `${teammateId}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db
    .insert(projectCollaborator)
    .values({ projectId: created.id, userId: teammateId, role: "editor" });
  const projects = (await getProjects({ db, userId: ownerId })).projects;
  assert.equal(
    projects.find((item) => item.id === created.id)?.collaborators[0]?.user?.id,
    teammateId,
  );
  for (const role of ["viewer", "editor"] as const) {
    await db
      .update(projectCollaborator)
      .set({ role })
      .where(eq(projectCollaborator.projectId, created.id));
    const shared = await getProject({
      db,
      ownerId: teammateId,
      projectId: created.id,
    });
    assert.equal(shared.id, created.id);
    assert.equal(shared.canWrite, role === "editor");
    const listed = (
      await getProjects({ db, userId: teammateId })
    ).projects.filter((item) => item.id === created.id);
    assert.equal(listed.length, 1, `${role} can discover the shared project`);
    assert.equal(listed[0]?.ownerId, ownerId);
    assert.equal(listed[0]?.organizationId, null);
    assert.equal(listed[0]?.collaborators[0]?.user?.id, teammateId);
  }
  await assert.rejects(
    getProject({ db, ownerId: crypto.randomUUID(), projectId: created.id }),
    /Project not found/,
  );
  await assert.rejects(
    createProjectNode({
      db,
      ownerId,
      data: {
        id: crypto.randomUUID(),
        projectId: created.id,
        parentId: folder.id,
        name: "out",
        kind: "folder",
      },
    }),
    /reserved for generated build files/,
  );

  await createProjectNode({
    db,
    ownerId,
    data: {
      id: crypto.randomUUID(),
      projectId: created.id,
      parentId: folder.id,
      name: "notes.tex",
      kind: "text",
    },
  });
  await assert.rejects(
    createProjectNode({
      db,
      ownerId,
      data: {
        id: crypto.randomUUID(),
        projectId: created.id,
        parentId: folder.id,
        name: "notes.tex",
        kind: "text",
      },
    }),
  );
  assert.equal(
    (await getProject({ db, ownerId, projectId: created.id })).nodes.filter(
      (item) => item.name === "notes.tex",
    ).length,
    1,
  );

  await db.insert(projectCollaborator).values({
    projectId: created.id,
    userId: ownerId,
    role: "viewer",
  });
  assert.equal(
    (await getProjects({ db, userId: ownerId })).projects.filter(
      (item) => item.id === created.id,
    ).length,
    1,
    "Ownership and collaboration return the project only once",
  );
  assert.equal(
    (await getProject({ db, ownerId, projectId: created.id })).canWrite,
    true,
  );

  const unshared = await createProject({
    db,
    ownerId: teammateId,
    data: { id: crypto.randomUUID(), name: "Unshared personal project" },
  });
  await assertInaccessible({ userId: ownerId, projectId: unshared.id });

  await db
    .delete(projectCollaborator)
    .where(
      and(
        eq(projectCollaborator.projectId, created.id),
        eq(projectCollaborator.userId, teammateId),
      ),
    );
  await assertInaccessible({ userId: teammateId, projectId: created.id });

  await db.insert(organization).values({
    id: organizationId,
    name: "Project listing test",
    slug: organizationId,
    createdAt: new Date(),
  });
  const organizationProjectId = crypto.randomUUID();
  await db.insert(project).values({
    id: organizationProjectId,
    organizationId,
    name: "Organization project",
  });
  await db.insert(projectCollaborator).values({
    projectId: organizationProjectId,
    userId: teammateId,
    role: "editor",
  });
  await assertInaccessible({
    userId: teammateId,
    projectId: organizationProjectId,
  });

  const membershipId = crypto.randomUUID();
  await db.insert(member).values({
    id: membershipId,
    organizationId,
    userId: teammateId,
    role: "member",
    createdAt: new Date(),
  });
  const organizationProjects = (
    await getProjects({ db, userId: teammateId })
  ).projects.filter((item) => item.id === organizationProjectId);
  assert.equal(organizationProjects.length, 1);
  assert.equal(organizationProjects[0]?.ownerId, null);
  assert.equal(organizationProjects[0]?.organizationId, organizationId);
  // Plain `member` role is an editor by policy (docs/project-controls.md).
  assert.equal(
    (
      await getProject({
        db,
        ownerId: teammateId,
        projectId: organizationProjectId,
      })
    ).canWrite,
    true,
  );
  await db.delete(member).where(eq(member.id, membershipId));
  await assertInaccessible({
    userId: teammateId,
    projectId: organizationProjectId,
  });

  await db.insert(projectCollaborator).values({
    projectId: created.id,
    userId: teammateId,
    role: "editor",
  });
  await trashProject({ db, userId: ownerId, projectId: created.id });
  for (const userId of [ownerId, teammateId])
    await assertInaccessible({ userId, projectId: created.id });

  const recreated = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: created.name },
  });
  assert.notEqual(recreated.id, created.id);
  const deleted = await db.query.project.findFirst({
    where: { id: created.id },
    with: { nodes: true },
  });
  assert(deleted?.deletedAt);
  assert.equal(deleted.name, created.name);
  assert.equal(deleted.nodes.length, loaded.nodes.length + 1);
  assert.equal(
    (await getProjects({ db, userId: ownerId })).projects.filter(
      (item) => item.name === created.name,
    ).length,
    1,
  );

  await trashProject({ db, userId: ownerId, projectId: recreated.id });
  const competing = await Promise.allSettled(
    [crypto.randomUUID(), crypto.randomUUID()].map((id) =>
      createProject({ db, ownerId, data: { id, name: created.name } }),
    ),
  );
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = competing.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert(rejected.reason instanceof Error);
  const cause = rejected.reason.cause;
  assert(cause instanceof Error && "code" in cause && "constraint" in cause);
  assert.equal(cause.code, "23505");
  assert.equal(cause.constraint, "project_owner_id_name_idx");
  const history = await db.query.project.findMany({
    where: { ownerId, name: created.name },
    with: { nodes: true },
  });
  assert.equal(history.length, 3);
  assert.equal(history.filter((item) => item.deletedAt).length, 2);
  const active = history.filter((item) => !item.deletedAt);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.nodes.length, 2);

  const otherOwnerProject = await createProject({
    db,
    ownerId: teammateId,
    data: { id: crypto.randomUUID(), name: created.name },
  });
  assert.equal(otherOwnerProject.name, created.name);

  await checkComments(db);
  await checkSharingNotifications(db);

  console.log(
    "Postgres integration passed: project listings and direct access, shared personal and organization projects, revocation and deletion, deleted project name reuse, concurrent active name uniqueness, transaction rollback, review comments, and sharing notifications",
  );
} finally {
  await db.delete(organization).where(eq(organization.id, organizationId));
  await db.delete(user).where(eq(user.id, ownerId));
  await db.delete(user).where(eq(user.id, teammateId));
  await db.$client.end();
}

import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import {
  projectCollaborator,
  projectNodeText,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

import { createProjectNode } from "../src/lib/project-node.server";
import {
  createProject,
  getProject,
  getProjects,
} from "../src/lib/project.server";

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
    (await getProjects({ db, ownerId })).some((item) => item.id === created.id),
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
  const projects = await getProjects({ db, ownerId });
  assert.equal(
    projects.find((item) => item.id === created.id)?.collaborators[0]?.user?.id,
    teammateId,
  );
  assert.equal(
    (await getProject({ db, ownerId: teammateId, projectId: created.id })).id,
    created.id,
  );
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

  const node = await createProjectNode({
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
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  await db.insert(projectNodeText).values({ nodeId: node.id, yjsState: bytes });
  const stored = await db.query.projectNodeText.findFirst({
    where: { nodeId: node.id },
  });
  assert.deepEqual(stored?.yjsState, bytes);
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

  console.log(
    "Postgres integration passed: projects, collaborator relations, binary text state, transaction rollback, and ownership checks",
  );
} finally {
  await db.delete(user).where(eq(user.id, ownerId));
  await db.delete(user).where(eq(user.id, teammateId));
  await db.$client.end();
}

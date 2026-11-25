import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  projectShareLink,
  user,
} from "@texfolia/db/schema";
import { eq, inArray } from "drizzle-orm";

import { deletionNotice, invalidateProjectAccess } from "#/lib/projects/live";

import {
  lockProject,
  lockProjectReaders,
  sharePrincipal,
} from "../../src/lib/sharing/project-access.server";

// Checking many people at once must agree with checking each one.
export async function checkProjectReaders(db: Db) {
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  const [ownerId, editorId, viewerId, memberId, strangerId] = ids;
  assert(ownerId && editorId && viewerId && memberId && strangerId);
  const organizationId = crypto.randomUUID();
  const personalId = crypto.randomUUID();
  const sharedId = crypto.randomUUID();
  const trashedId = crypto.randomUUID();
  await db.insert(user).values(
    ids.map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      createdAt: new Date(),
    })),
  );
  await db.insert(organization).values({
    id: organizationId,
    name: "Readers",
    slug: organizationId,
    createdAt: new Date(),
  });
  try {
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: memberId,
      createdAt: new Date(),
    });
    await db.insert(project).values([
      { id: personalId, ownerId, name: personalId },
      { id: sharedId, organizationId, name: sharedId },
      { id: trashedId, ownerId, name: trashedId, deletedAt: new Date() },
    ]);
    // Collaborator rows grant nothing in an organization's project.
    await db.insert(projectCollaborator).values(
      [personalId, sharedId].flatMap((projectId) => [
        { projectId, userId: editorId, role: "editor" as const },
        { projectId, userId: viewerId, role: "viewer" as const },
      ]),
    );
    const links = await db
      .insert(projectShareLink)
      .values(
        [personalId, sharedId].flatMap((projectId) =>
          (["project", "pdf"] as const).map((scope) => ({
            projectId,
            scope,
            tokenHash: crypto.randomUUID(),
            createdBy: ownerId,
          })),
        ),
      )
      .returning({ id: projectShareLink.id });
    const principals = [
      ...ids,
      ...links.map(({ id }) => sharePrincipal(id)),
      sharePrincipal(crypto.randomUUID()),
    ];
    let allowed = 0;
    for (const projectId of [
      personalId,
      sharedId,
      trashedId,
      crypto.randomUUID(),
    ]) {
      const readers = await db.transaction((tx) =>
        lockProjectReaders({ tx, projectId, userIds: principals }),
      );
      for (const userId of principals) {
        const alone = await db
          .transaction((tx) =>
            lockProject({ tx, projectId, userId, access: "read" }),
          )
          .then(
            ({ canWrite }) => ({ canWrite }),
            () => undefined,
          );
        assert.deepEqual(readers.get(userId), alone, `${projectId} ${userId}`);
        if (alone) allowed++;
      }
      const none = await db.transaction((tx) =>
        lockProjectReaders({ tx, projectId, userIds: [] }),
      );
      assert.equal(none.size, 0);
    }
    assert.equal(allowed, 6);

    // Pushes reach every project that a deleted account or organization affects,
    // and are retried.
    const pushes: [string, string[] | undefined][] = [];
    let failures = 2;
    const channel = {
      getByName: (projectId: string) => ({
        async invalidateAccess(userIds?: string[]) {
          if (failures-- > 0) throw new Error("Durable Object reset");
          pushes.push([projectId, userIds]);
        },
      }),
    };
    const live = {
      collaboration: channel,
      builds: { getByName: () => ({ async invalidateAccess() {} }) },
    };
    await invalidateProjectAccess(live, personalId, [viewerId]);
    assert.deepEqual(pushes, [[personalId, [viewerId]]]);
    const notified = async (
      deleted: Parameters<ReturnType<typeof deletionNotice>["before"]>[0],
    ) => {
      pushes.length = 0;
      const notice = deletionNotice({ db, live });
      await notice.before(deleted);
      assert.deepEqual(pushes, [], "Nothing is pushed before the deletion");
      await notice.after();
      return new Map(pushes);
    };
    assert.deepEqual(
      await notified({ userId: memberId }),
      new Map([[sharedId, [memberId]]]),
    );
    assert.deepEqual(
      await notified({ userId: viewerId }),
      new Map([
        [personalId, [viewerId]],
        [sharedId, [viewerId]],
      ]),
    );
    assert.deepEqual(
      await notified({ userId: ownerId }),
      new Map([
        [personalId, undefined],
        [trashedId, undefined],
      ]),
    );
    assert.deepEqual(
      await notified({ organizationId }),
      new Map([[sharedId, undefined]]),
    );
  } finally {
    await db
      .delete(project)
      .where(inArray(project.id, [personalId, sharedId, trashedId]));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(inArray(user.id, ids));
  }
}

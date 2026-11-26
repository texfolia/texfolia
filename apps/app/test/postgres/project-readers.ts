import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  projectShareGrant,
  projectShareLink,
  projectTeam,
  team,
  teamMember,
  user,
} from "@texfolia/db/schema";
import { eq, inArray } from "drizzle-orm";

import { deletionNotice, invalidateProjectAccess } from "#/lib/projects/live";
import type { ProjectRole } from "#/lib/projects/roles";

import {
  lockProject,
  lockProjectReaders,
  sharePrincipal,
} from "../../src/lib/sharing/project-access.server";

async function roleOf(db: Db, projectId: string, userId: string) {
  return db
    .transaction((tx) => lockProject({ tx, projectId, userId, access: "read" }))
    .then(
      ({ role, guest }) => (guest ? `guest ${role}` : role),
      () => null,
    );
}

// Every source of access adds up to the strongest role, and checking many
// people at once agrees with checking each one.
export async function checkProjectReaders(db: Db) {
  const names = [
    "owner",
    "editor",
    "commenter",
    "viewer",
    "member",
    "admin",
    "teammate",
    "outsider",
    "linked",
    "stranger",
  ] as const;
  const people = Object.fromEntries(
    names.map((name) => [name, crypto.randomUUID()]),
  ) as Record<(typeof names)[number], string>;
  const ids = Object.values(people);
  const organizationId = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const personalId = crypto.randomUUID();
  const openId = crypto.randomUUID();
  const closedId = crypto.randomUUID();
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
    await db.insert(member).values(
      (
        [
          ["commenter", "member"],
          ["member", "member"],
          ["admin", "admin"],
          ["teammate", "member"],
        ] as const
      ).map(([name, role]) => ({
        id: crypto.randomUUID(),
        organizationId,
        userId: people[name],
        role,
        createdAt: new Date(),
      })),
    );
    await db.insert(team).values({
      id: teamId,
      name: "Reviewers",
      organizationId,
      createdAt: new Date(),
    });
    await db.insert(teamMember).values({
      id: crypto.randomUUID(),
      teamId,
      userId: people.teammate,
      createdAt: new Date(),
    });
    await db.insert(project).values([
      { id: personalId, ownerId: people.owner, name: personalId },
      {
        id: openId,
        organizationId,
        organizationRole: "viewer",
        name: openId,
      },
      { id: closedId, organizationId, organizationRole: null, name: closedId },
      {
        id: trashedId,
        ownerId: people.owner,
        name: trashedId,
        deletedAt: new Date(),
      },
    ]);
    await db.insert(projectCollaborator).values([
      ...[personalId, trashedId].flatMap((projectId) =>
        (["editor", "commenter", "viewer"] as const).map((role) => ({
          projectId,
          userId: people[role],
          role,
        })),
      ),
      // On organization projects, grants count only for members.
      { projectId: openId, userId: people.commenter, role: "commenter" },
      { projectId: closedId, userId: people.outsider, role: "editor" },
    ]);
    await db.insert(projectTeam).values([
      { projectId: openId, teamId, role: "editor" },
      { projectId: closedId, teamId, role: "commenter" },
    ]);
    const links = await db
      .insert(projectShareLink)
      .values(
        [personalId, closedId].flatMap((projectId) =>
          (["viewer", "commenter", "editor"] as const).map((role) => ({
            projectId,
            role,
            tokenHash: crypto.randomUUID(),
            createdBy: people.owner,
          })),
        ),
      )
      .returning({
        id: projectShareLink.id,
        projectId: projectShareLink.projectId,
        role: projectShareLink.role,
      });
    const link = (projectId: string, role: ProjectRole) => {
      const found = links.find(
        (item) => item.projectId === projectId && item.role === role,
      );
      assert(found);
      return found.id;
    };
    // Redeeming a link gives an account its role, even outside the
    // organization, and a weaker link never lowers a stronger grant.
    await db.insert(projectShareGrant).values([
      {
        linkId: link(personalId, "commenter"),
        projectId: personalId,
        userId: people.linked,
      },
      {
        linkId: link(closedId, "editor"),
        projectId: closedId,
        userId: people.linked,
      },
      {
        linkId: link(personalId, "viewer"),
        projectId: personalId,
        userId: people.editor,
      },
    ]);
    const guests = links.map(({ id }) => sharePrincipal(id));
    const principals = [...ids, ...guests, sharePrincipal(crypto.randomUUID())];

    const expected: Record<string, Partial<Record<string, string>>> = {
      [personalId]: {
        [people.owner]: "editor",
        [people.editor]: "editor",
        [people.commenter]: "commenter",
        [people.viewer]: "viewer",
        [people.linked]: "commenter",
        // Anonymous guests can only use view links.
        [sharePrincipal(link(personalId, "viewer"))]: "guest viewer",
      },
      [openId]: {
        [people.commenter]: "commenter",
        [people.member]: "viewer",
        [people.admin]: "editor",
        [people.teammate]: "editor",
      },
      [closedId]: {
        [people.admin]: "editor",
        [people.teammate]: "commenter",
        [people.linked]: "editor",
        [sharePrincipal(link(closedId, "viewer"))]: "guest viewer",
      },
      [trashedId]: {},
    };
    for (const [projectId, roles] of Object.entries(expected)) {
      const readers = await db.transaction((tx) =>
        lockProjectReaders({ tx, projectId, userIds: principals }),
      );
      for (const userId of principals) {
        const role = await roleOf(db, projectId, userId);
        assert.equal(role, roles[userId] ?? null, `${projectId} ${userId}`);
        assert.deepEqual(
          readers.get(userId),
          role ? { canWrite: role === "editor" } : undefined,
          `readers ${projectId} ${userId}`,
        );
      }
      const none = await db.transaction((tx) =>
        lockProjectReaders({ tx, projectId, userIds: [] }),
      );
      assert.equal(none.size, 0);
    }

    // Requests that need more than the role allows are refused.
    const denied = (
      projectId: string,
      userId: string,
      access: "comment" | "write",
    ) =>
      assert.rejects(
        db.transaction((tx) => lockProject({ tx, projectId, userId, access })),
        /Project not found/,
      );
    await denied(personalId, people.viewer, "comment");
    await denied(personalId, people.commenter, "write");
    await denied(openId, people.member, "comment");
    await db.transaction((tx) =>
      lockProject({
        tx,
        projectId: personalId,
        userId: people.commenter,
        access: "comment",
      }),
    );

    // Revoking a link removes every grant made from it.
    await db
      .delete(projectShareLink)
      .where(eq(projectShareLink.id, link(closedId, "editor")));
    assert.equal(await roleOf(db, closedId, people.linked), null);
    // Leaving the organization ends member, team, and collaborator access.
    await db.delete(member).where(eq(member.userId, people.teammate));
    assert.equal(await roleOf(db, openId, people.teammate), null);

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
    await invalidateProjectAccess(live, personalId, [people.viewer]);
    assert.deepEqual(pushes, [[personalId, [people.viewer]]]);
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
      await notified({ userId: people.member }),
      new Map([
        [openId, [people.member]],
        [closedId, [people.member]],
      ]),
    );
    assert.deepEqual(
      await notified({ userId: people.linked }),
      new Map([[personalId, [people.linked]]]),
    );
    assert.deepEqual(
      await notified({ userId: people.owner }),
      new Map([
        [personalId, undefined],
        [trashedId, undefined],
      ]),
    );
    assert.deepEqual(
      await notified({ organizationId }),
      new Map([
        [openId, undefined],
        [closedId, undefined],
      ]),
    );
  } finally {
    await db
      .delete(project)
      .where(inArray(project.id, [personalId, openId, closedId, trashedId]));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(inArray(user.id, ids));
  }
}

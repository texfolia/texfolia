import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  sharingLimit,
  user,
} from "@texfolia/db/schema";
import { eq, inArray } from "drizzle-orm";

import type { EmailMessage } from "../../src/lib/email";
import { createProject } from "../../src/lib/projects/project.server";
import {
  createShareLink,
  listShareLinks,
} from "../../src/lib/sharing/project-share-links.server";
import {
  getProjectAccess,
  grantProjectAccess,
  revokeProjectAccess,
} from "../../src/lib/sharing/project-sharing.server";
import { sharingEmailLimits } from "../../src/lib/sharing/sharing-limit.server";

const baseURL = "https://app.texfolia.com";

export async function checkSharingNotifications(db: Db) {
  const [ownerId, collaboratorId] = [crypto.randomUUID(), crypto.randomUUID()];
  const organizationId = crypto.randomUUID();
  const ids = [ownerId, collaboratorId];
  const ownerEmail = `owner-${ownerId}@example.com`;
  const collaboratorEmail = `collab-${collaboratorId}@example.com`;
  await db.insert(user).values([
    {
      id: ownerId,
      name: "Ada Owner",
      email: ownerEmail,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: collaboratorId,
      name: "Grace Coauthor",
      email: collaboratorEmail,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  try {
    const created = await createProject({
      db,
      ownerId,
      data: { id: crypto.randomUUID(), name: `Paper ${ownerId.slice(0, 8)}` },
    });
    const projectId = created.id;
    const sent: EmailMessage[] = [];
    const email = {
      baseURL,
      send: async (message: EmailMessage) => {
        sent.push(message);
      },
    };

    // Adding a new collaborator queues one actionable email.
    const added = await grantProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, email: collaboratorEmail, role: "viewer" },
      email,
    });
    assert.equal(added, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, collaboratorEmail);
    assert.match(sent[0]?.subject ?? "", new RegExp(created.name));
    assert(sent[0]?.text.includes(`${baseURL}/project/${projectId}`));
    assert(sent[0]?.text.includes("so you can view it"));
    assert(sent[0]?.text.includes("Ada Owner"));

    // Updating an existing collaborator's role does not spam another email.
    await grantProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, email: collaboratorEmail, role: "editor" },
      email,
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(
      await db
        .select({ count: sharingLimit.count })
        .from(sharingLimit)
        .where(eq(sharingLimit.userId, ownerId)),
      [{ count: 1 }, { count: 1 }],
      "role changes don't use the sharing budget",
    );

    // Only people who manage access see emails.
    const emails = async (userId: string) => {
      const access = await getProjectAccess({ db, userId, projectId });
      const people = new Map(
        [
          ...(access.owner ? [access.owner] : []),
          ...access.people,
          ...(access.organization?.managers ?? []),
        ].map((person) => [person.id, person.email]),
      );
      return [...people.values()].sort();
    };
    assert.deepEqual(
      await emails(ownerId),
      [ownerEmail, collaboratorEmail].sort(),
    );
    assert.deepEqual(await emails(collaboratorId), [null, null]);

    // Self-share rejects. An unknown account looks like a known one.
    await assert.rejects(
      grantProjectAccess({
        db,
        userId: ownerId,
        data: { projectId, email: ownerEmail, role: "editor" },
        email,
      }),
      /already have access/,
    );
    assert.equal(
      await grantProjectAccess({
        db,
        userId: ownerId,
        data: { projectId, email: "missing@example.com", role: "viewer" },
        email,
      }),
      added,
    );
    assert.equal(sent.length, 1);

    // Revoking and re-adding sends a new email, and queue failures do not roll back access.
    await revokeProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, userId: collaboratorId },
    });
    await grantProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, email: collaboratorEmail, role: "editor" },
      email: {
        baseURL,
        send: () => Promise.reject(new Error("smtp down")),
      },
    });
    assert.equal((await emails(ownerId)).length, 2);

    // Bare share links send no email.
    const bare = await createShareLink({
      db,
      userId: ownerId,
      data: { projectId, role: "viewer" },
      email,
    });
    assert.equal(bare.notification, "none");
    assert.equal(sent.length, 1);

    // Share links to a specific external recipient email that person directly.
    const externalEmail = "external-reviewer@example.com";
    const emailed = await createShareLink({
      db,
      userId: ownerId,
      data: { projectId, role: "commenter", recipientEmail: externalEmail },
      email,
    });
    assert.equal(emailed.notification, "queued");
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.to, externalEmail);
    assert(sent[1]?.text.includes(`${baseURL}/share/${emailed.token}`));
    assert(sent[1]?.text.includes("comment on it after signing in"));

    // Owner and existing collaborators are rejected before creating a share link.
    const linksBefore = (
      await listShareLinks({ db, userId: ownerId, projectId })
    ).links.length;
    await assert.rejects(
      createShareLink({
        db,
        userId: ownerId,
        data: {
          projectId,
          role: "viewer",
          recipientEmail: ownerEmail.toUpperCase(),
        },
        email,
      }),
      /already have access/,
    );
    await assert.rejects(
      createShareLink({
        db,
        userId: ownerId,
        data: {
          projectId,
          role: "viewer",
          recipientEmail: collaboratorEmail,
        },
        email,
      }),
      /already has access/,
    );
    assert.equal(
      (await listShareLinks({ db, userId: ownerId, projectId })).links.length,
      linksBefore,
    );
    assert.equal(sent.length, 2);

    // Delivery failure on a share link still returns the created token.
    const failedShare = await createShareLink({
      db,
      userId: ownerId,
      data: {
        projectId,
        role: "viewer",
        recipientEmail: "another-reviewer@example.com",
      },
      email: {
        baseURL,
        send: () => Promise.reject(new Error("smtp down")),
      },
    });
    assert.equal(failedShare.notification, "failed");
    assert.equal(failedShare.token.length, 43);

    // Parallel and repeated sharing stays within one budget, and a refused
    // share link is not created.
    await db.delete(sharingLimit).where(eq(sharingLimit.userId, ownerId));
    const attempts = await Promise.allSettled(
      Array.from({ length: sharingEmailLimits.minute + 2 }, (_, i) =>
        grantProjectAccess({
          db,
          userId: ownerId,
          data: {
            projectId,
            email: `missing-${i}@example.com`,
            role: "viewer",
          },
        }),
      ),
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      sharingEmailLimits.minute,
    );
    const shareByEmail = () =>
      createShareLink({
        db,
        userId: ownerId,
        data: { projectId, role: "commenter", recipientEmail: externalEmail },
        email,
      });
    const limitedBefore = sent.length;
    const linkCount = async () =>
      (await listShareLinks({ db, userId: ownerId, projectId })).links.length;
    const countBefore = await linkCount();
    await assert.rejects(shareByEmail(), /too quickly/);
    assert.equal(await linkCount(), countBefore);
    assert.equal(sent.length, limitedBefore);
    await createShareLink({
      db,
      userId: ownerId,
      data: { projectId, role: "commenter" },
    });
    // A new minute allows sharing until the daily budget runs out.
    const aMinuteAgo = new Date(Date.now() - 61_000);
    await db
      .update(sharingLimit)
      .set({ startedAt: aMinuteAgo })
      .where(eq(sharingLimit.userId, ownerId));
    await shareByEmail();
    assert.equal(sent.length, limitedBefore + 1);
    await db
      .update(sharingLimit)
      .set({ startedAt: aMinuteAgo, count: sharingEmailLimits.day })
      .where(eq(sharingLimit.userId, ownerId));
    await assert.rejects(shareByEmail(), /today's sharing limit/);
    assert.equal(sent.length, limitedBefore + 1);

    // In an organization, only owners and admins see members' emails.
    await db.insert(organization).values({
      id: organizationId,
      name: "Lab",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(member).values(
      [
        { userId: ownerId, role: "member,admin" },
        { userId: collaboratorId, role: "member" },
      ].map((row) => ({
        ...row,
        id: crypto.randomUUID(),
        organizationId,
        createdAt: new Date(),
      })),
    );
    await db
      .update(project)
      .set({ ownerId: null, organizationId })
      .where(eq(project.id, projectId));
    assert.deepEqual(
      await emails(ownerId),
      [ownerEmail, collaboratorEmail].sort(),
    );
    assert.deepEqual(await emails(collaboratorId), [null, null]);
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(inArray(user.id, ids));
  }
}

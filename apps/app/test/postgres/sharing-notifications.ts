import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import { user } from "@texfolia/db/schema";
import { inArray } from "drizzle-orm";

import type { EmailMessage } from "../../src/lib/email";
import { createProject } from "../../src/lib/projects/project.server";
import {
  createShareLink,
  listShareLinks,
} from "../../src/lib/sharing/project-share-links.server";
import {
  grantProjectAccess,
  revokeProjectAccess,
} from "../../src/lib/sharing/project-sharing.server";

const baseURL = "https://app.texfolia.com";

export async function checkSharingNotifications(db: Db) {
  const [ownerId, collaboratorId] = [crypto.randomUUID(), crypto.randomUUID()];
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

    // Adding a new collaborator sends one actionable email.
    const added = await grantProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, email: collaboratorEmail, role: "viewer" },
      email,
    });
    assert.deepEqual(added, { added: true, notification: "sent" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, collaboratorEmail);
    assert.match(sent[0]?.subject ?? "", new RegExp(created.name));
    assert(sent[0]?.text.includes(`${baseURL}/project/${projectId}`));
    assert(sent[0]?.text.includes("so you can view it"));
    assert(sent[0]?.text.includes("Ada Owner"));

    // Updating an existing collaborator's role does not spam another email.
    const upgraded = await grantProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, email: collaboratorEmail, role: "editor" },
      email,
    });
    assert.deepEqual(upgraded, { added: false, notification: "none" });
    assert.equal(sent.length, 1);

    // Self-share and unknown accounts reject without sending email.
    await assert.rejects(
      grantProjectAccess({
        db,
        userId: ownerId,
        data: { projectId, email: ownerEmail, role: "editor" },
        email,
      }),
      /already own/,
    );
    await assert.rejects(
      grantProjectAccess({
        db,
        userId: ownerId,
        data: { projectId, email: "missing@example.com", role: "viewer" },
        email,
      }),
      /No Texfolia account/,
    );
    assert.equal(sent.length, 1);

    // Revoking and re-adding sends a new email, and delivery failures do not roll back access.
    await revokeProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, userId: collaboratorId },
    });
    const readdedFailed = await grantProjectAccess({
      db,
      userId: ownerId,
      data: { projectId, email: collaboratorEmail, role: "editor" },
      email: {
        baseURL,
        send: () => Promise.reject(new Error("smtp down")),
      },
    });
    assert.deepEqual(readdedFailed, { added: true, notification: "failed" });

    // Bare share links send no email.
    const bare = await createShareLink({
      db,
      userId: ownerId,
      data: { projectId, scope: "project" },
      email,
    });
    assert.equal(bare.notification, "none");
    assert.equal(sent.length, 1);

    // Share links to a specific external recipient email that person directly.
    const externalEmail = "external-reviewer@example.com";
    const emailed = await createShareLink({
      db,
      userId: ownerId,
      data: { projectId, scope: "pdf", recipientEmail: externalEmail },
      email,
    });
    assert.equal(emailed.notification, "sent");
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.to, externalEmail);
    assert(sent[1]?.text.includes(`${baseURL}/share/${emailed.token}`));
    assert(sent[1]?.text.includes("view its PDF without signing in"));

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
          scope: "project",
          recipientEmail: ownerEmail.toUpperCase(),
        },
        email,
      }),
      /already own/,
    );
    await assert.rejects(
      createShareLink({
        db,
        userId: ownerId,
        data: {
          projectId,
          scope: "project",
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
        scope: "project",
        recipientEmail: "another-reviewer@example.com",
      },
      email: {
        baseURL,
        send: () => Promise.reject(new Error("smtp down")),
      },
    });
    assert.equal(failedShare.notification, "failed");
    assert.equal(failedShare.token.length, 43);
  } finally {
    await db.delete(user).where(inArray(user.id, ids));
  }
}

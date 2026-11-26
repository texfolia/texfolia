import { expect, test } from "bun:test";

import { createShareLinkSchema } from "./project-share-links.schema";
import { grantProjectAccessSchema } from "./project-sharing.schema";

const projectId = "00000000-0000-4000-8000-000000000001";

test("createShareLinkSchema allows bare links without a recipient email", () => {
  expect(createShareLinkSchema.parse({ projectId, role: "viewer" })).toEqual({
    projectId,
    role: "viewer",
  });
  expect(
    createShareLinkSchema.safeParse({ projectId, role: "commenter" }).success,
  ).toBe(true);
  // PDF-only links no longer exist.
  expect(
    createShareLinkSchema.safeParse({ projectId, role: "pdf" }).success,
  ).toBe(false);
});

test("createShareLinkSchema trims and lowercases an optional recipient email", () => {
  expect(
    createShareLinkSchema.parse({
      projectId,
      role: "editor",
      recipientEmail: "  Reviewer@Example.COM ",
    }),
  ).toEqual({
    projectId,
    role: "editor",
    recipientEmail: "reviewer@example.com",
  });
  expect(
    createShareLinkSchema.safeParse({
      projectId,
      role: "viewer",
      recipientEmail: "not-an-email",
    }).success,
  ).toBe(false);
});

test("grantProjectAccessSchema normalizes collaborator emails", () => {
  expect(
    grantProjectAccessSchema.parse({
      projectId,
      email: "  CoAuthor@Example.COM ",
      role: "editor",
    }),
  ).toEqual({
    projectId,
    email: "coauthor@example.com",
    role: "editor",
  });
});

import { describe, expect, test } from "bun:test";

import { mentionEmail } from "#/lib/email/messages";
import {
  listNotificationsSchema,
  markNotificationReadSchema,
} from "#/lib/notifications/notifications.schema";

import {
  mentionCandidatesSchema,
  resolveMentionsSchema,
  syncScratchpadMentionsSchema,
} from "./mentions.schema";

const projectId = "00000000-0000-4000-8000-000000000001";
const notificationId = "00000000-0000-4000-8000-000000000002";

describe("mentions and notifications schemas", () => {
  test("validates mention schemas", () => {
    expect(mentionCandidatesSchema.parse({ projectId })).toEqual({ projectId });
    expect(
      syncScratchpadMentionsSchema.parse({ projectId, body: "Hello world" }),
    ).toEqual({ projectId, body: "Hello world" });
    expect(
      resolveMentionsSchema.parse({ projectId, userIds: ["u1", "u2"] }),
    ).toEqual({ projectId, userIds: ["u1", "u2"] });
    expect(
      resolveMentionsSchema.safeParse({ projectId, userIds: [""] }).success,
    ).toBe(false);
  });

  test("validates notification schemas", () => {
    expect(listNotificationsSchema.parse(undefined)).toBeUndefined();
    expect(listNotificationsSchema.parse({ limit: 25 })).toEqual({ limit: 25 });
    expect(listNotificationsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(markNotificationReadSchema.parse({ notificationId })).toEqual({
      notificationId,
    });
  });
});

describe("mentionEmail", () => {
  test("escapes HTML and formats comment and scratchpad mention emails", () => {
    const commentUrl = new URL(
      `/project/${projectId}?thread=t1`,
      "https://app.texfolia.com",
    );
    const commentMail = mentionEmail({
      to: "ada@example.com",
      actorName: "Grace <Admin>",
      projectName: "Paper & Notes\nDraft",
      surface: "comment",
      excerpt: "Check <section 2> please",
      url: commentUrl,
    });
    expect(commentMail.subject).toBe(
      "Grace <Admin> mentioned you in Paper & Notes Draft on Texfolia",
    );
    expect(commentMail.text).toContain("a review comment");
    expect(commentMail.text).toContain(commentUrl.href);
    expect(commentMail.html).toContain("&lt;section 2&gt;");
    expect(commentMail.html).toContain("Grace &lt;Admin&gt;");

    const scratchpadUrl = new URL(
      `/project/${projectId}?view=scratchpad`,
      "https://app.texfolia.com",
    );
    const scratchpadMail = mentionEmail({
      to: "ada@example.com",
      actorName: "Grace",
      projectName: "Paper",
      surface: "scratchpad",
      excerpt: "",
      url: scratchpadUrl,
    });
    expect(scratchpadMail.text).toContain("the project scratchpad");
    expect(scratchpadMail.html).not.toContain("<blockquote>");
  });
});

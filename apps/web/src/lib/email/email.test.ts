import { expect, test } from "bun:test";

import {
  codeEmail,
  createEmailDelivery,
  deleteAccountEmail,
  emailJobSchema,
  invitationEmail,
  projectCollaboratorEmail,
  projectShareLinkEmail,
  sendEmail,
  type EmailJob,
} from "./index";

const message = codeEmail({
  to: "writer@example.com",
  code: "123456",
  type: "forget-password",
});

test("code emails name their purpose", () => {
  expect(message.subject).toBe("Your Texfolia password reset code");
  expect(message.text).toContain("123456");
  expect(message.html).toContain("<strong>123456</strong>");
});

test("the deletion link is escaped in HTML only", () => {
  const url = 'https://app.texfolia.com/delete?a=1&b="2"';
  const email = deleteAccountEmail({ to: "writer@example.com", url });
  expect(email.text).toContain(url);
  expect(email.html).toContain("?a=1&amp;b=&quot;2&quot;");
});

test("invitation emails clean and escape the organization name", () => {
  const email = invitationEmail({
    to: "writer@example.com",
    organization: "Lab <b>\r\nBcc: x@example.com",
    url: new URL("https://app.texfolia.com/accept-invitation/1?a=1&b=2"),
  });
  expect(email.subject).toBe(
    "You're invited to join Lab <b> Bcc: x@example.com on Texfolia",
  );
  expect(email.text).not.toContain("\n");
  expect(email.html).toContain(
    "<strong>Lab &lt;b&gt; Bcc: x@example.com</strong>",
  );
  expect(email.html).toContain("?a=1&amp;b=2");
});

test("project collaborator emails include role, project link, and escape HTML", () => {
  const url = new URL("https://app.texfolia.com/project/proj-1?a=1&b=2");
  const editorMail = projectCollaboratorEmail({
    to: "coauthor@example.com",
    projectName: 'Paper <2> &\n"Notes"',
    inviterName: "Ada <Owner>",
    role: "editor",
    url,
  });
  expect(editorMail.to).toBe("coauthor@example.com");
  expect(editorMail.subject).toBe(
    'You were added to Paper <2> & "Notes" on Texfolia',
  );
  expect(editorMail.text).toContain("so you can edit it");
  expect(editorMail.text).toContain(url.href);
  expect(editorMail.html).toContain("Ada &lt;Owner&gt;");
  expect(editorMail.html).toContain(
    "<strong>Paper &lt;2&gt; &amp;\n&quot;Notes&quot;</strong>",
  );
  expect(editorMail.html).toContain(
    'href="https://app.texfolia.com/project/proj-1?a=1&amp;b=2"',
  );

  const viewerMail = projectCollaboratorEmail({
    to: "reader@example.com",
    projectName: "Draft",
    inviterName: "Ada",
    role: "viewer",
    url: new URL("https://app.texfolia.com/project/proj-2"),
  });
  expect(viewerMail.text).toContain("so you can view it");
  expect(viewerMail.html).toContain("so you can view it");

  const commenterMail = projectCollaboratorEmail({
    to: "reviewer@example.com",
    projectName: "Draft",
    inviterName: "Ada",
    role: "commenter",
    url: new URL("https://app.texfolia.com/project/proj-3"),
  });
  expect(commenterMail.text).toContain("so you can comment on it");
});

test("project share-link emails describe the role and whether to sign in", () => {
  const projectMail = projectShareLinkEmail({
    to: "reviewer@example.com",
    projectName: "Thesis & <Draft>",
    senderName: "Ada\nLovelace",
    role: "viewer",
    url: new URL("https://app.texfolia.com/share/abc_123"),
  });
  expect(projectMail.to).toBe("reviewer@example.com");
  expect(projectMail.subject).toBe(
    "Ada Lovelace shared Thesis & <Draft> on Texfolia",
  );
  expect(projectMail.text).toContain(
    "so you can view it without signing in: https://app.texfolia.com/share/abc_123",
  );
  expect(projectMail.html).toContain(
    "<strong>Thesis &amp; &lt;Draft&gt;</strong>",
  );
  expect(projectMail.html).toContain(
    '<a href="https://app.texfolia.com/share/abc_123">Open shared link</a>',
  );

  for (const [role, access] of [
    ["commenter", "comment on it"],
    ["editor", "edit it"],
  ] as const) {
    const mail = projectShareLinkEmail({
      to: "reviewer@example.com",
      projectName: "Thesis",
      senderName: "Ada",
      role,
      url: new URL("https://app.texfolia.com/share/def_456"),
    });
    expect(mail.text).toContain(
      `so you can ${access} after signing in or creating an account`,
    );
    expect(mail.html).toContain(`so you can ${access} after signing in`);
  }
});

test("messages go out from the configured address and delivery errors reject", async () => {
  const sent: unknown[] = [];
  const env = (send: SendEmail["send"]) => ({
    EMAIL: { send },
    EMAIL_FROM: "mail@example.com",
  });
  await sendEmail(
    env(async (email: unknown) => {
      sent.push(email);
      return { messageId: "1" };
    }),
    message,
  );
  expect(sent).toEqual([{ from: "mail@example.com", ...message }]);
  await expect(
    sendEmail(
      env(() => Promise.reject(new Error("unavailable"))),
      message,
    ),
  ).rejects.toThrow("unavailable");
});

test("createEmailDelivery queues emails and requires a queue and baseURL", async () => {
  const sent: unknown[] = [];
  const queue = {
    async send(job: EmailJob) {
      sent.push(job);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  expect(createEmailDelivery(undefined, "https://app.texfolia.com")).toBe(
    undefined,
  );
  expect(createEmailDelivery(queue, undefined)).toBe(undefined);
  const delivery = createEmailDelivery(queue, "https://app.texfolia.com");
  expect(delivery?.baseURL).toBe("https://app.texfolia.com");
  await delivery?.send(message);
  expect(sent).toEqual([{ kind: "email", message }]);
  expect(emailJobSchema.parse(sent[0])).toEqual({ kind: "email", message });
});

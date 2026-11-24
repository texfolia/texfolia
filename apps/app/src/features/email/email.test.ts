import { expect, test } from "bun:test";

import {
  codeEmail,
  createEmailDelivery,
  deleteAccountEmail,
  projectCollaboratorEmail,
  projectShareLinkEmail,
  sendEmail,
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
});

test("project share-link emails describe the scope and link without requiring sign-in", () => {
  const projectMail = projectShareLinkEmail({
    to: "reviewer@example.com",
    projectName: "Thesis & <Draft>",
    senderName: "Ada\nLovelace",
    scope: "project",
    url: new URL("https://app.texfolia.com/share/abc_123"),
  });
  expect(projectMail.to).toBe("reviewer@example.com");
  expect(projectMail.subject).toBe(
    "Ada Lovelace shared Thesis & <Draft> on Texfolia",
  );
  expect(projectMail.text).toContain(
    "view its sources and PDF without signing in: https://app.texfolia.com/share/abc_123",
  );
  expect(projectMail.html).toContain(
    "<strong>Thesis &amp; &lt;Draft&gt;</strong>",
  );
  expect(projectMail.html).toContain(
    '<a href="https://app.texfolia.com/share/abc_123">Open shared link</a>',
  );

  const pdfMail = projectShareLinkEmail({
    to: "reviewer@example.com",
    projectName: "Thesis",
    senderName: "Ada",
    scope: "pdf",
    url: new URL("https://app.texfolia.com/share/pdf_456"),
  });
  expect(pdfMail.text).toContain("view its PDF without signing in");
  expect(pdfMail.html).toContain("view its PDF without signing in");
});

test("messages go out from the Texfolia address and delivery errors reject", async () => {
  const sent: unknown[] = [];
  await sendEmail({ send: async (email) => sent.push(email) }, message);
  expect(sent).toEqual([{ from: "noreply@texfolia.com", ...message }]);
  await expect(
    sendEmail(
      { send: () => Promise.reject(new Error("unavailable")) },
      message,
    ),
  ).rejects.toThrow("unavailable");
});

test("createEmailDelivery requires both binding and baseURL", async () => {
  const sent: unknown[] = [];
  const binding = { send: async (email: unknown) => sent.push(email) };
  expect(createEmailDelivery(undefined, "https://app.texfolia.com")).toBe(
    undefined,
  );
  expect(createEmailDelivery(binding, undefined)).toBe(undefined);
  const delivery = createEmailDelivery(binding, "https://app.texfolia.com");
  expect(delivery?.baseURL).toBe("https://app.texfolia.com");
  await delivery?.send(message);
  expect(sent).toEqual([{ from: "noreply@texfolia.com", ...message }]);
});

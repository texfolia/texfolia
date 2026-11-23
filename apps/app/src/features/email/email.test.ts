import { expect, test } from "bun:test";

import { codeEmail, deleteAccountEmail, sendEmail } from "./index";

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

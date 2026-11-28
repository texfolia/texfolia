import { z } from "zod";

export const emailMessageSchema = z.object({
  to: z.string().min(1),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;
export type DeliverEmail = (message: EmailMessage) => Promise<void>;

/** A queued email. The background queue's consumer sends it. */
export const emailJobSchema = z.object({
  kind: z.literal("email"),
  message: emailMessageSchema,
});
export type EmailJob = z.infer<typeof emailJobSchema>;

export type EmailDelivery = {
  baseURL: string;
  send: DeliverEmail;
};

export type EmailNotificationStatus = "queued" | "failed" | "none";

/** Sends through the Worker's `send_email` binding. Delivery errors reject. */
export async function sendEmail(
  { EMAIL, EMAIL_FROM }: { EMAIL: SendEmail; EMAIL_FROM: string },
  message: EmailMessage,
) {
  await EMAIL.send({ from: EMAIL_FROM, ...message });
}

/** Queues emails so a request doesn't wait for delivery. */
export function createEmailDelivery(
  queue: Pick<Queue<EmailJob>, "send"> | undefined,
  baseURL: string | undefined,
): EmailDelivery | undefined {
  if (!queue || !baseURL) return undefined;
  return {
    baseURL,
    async send(message) {
      await queue.send({ kind: "email", message });
    },
  };
}

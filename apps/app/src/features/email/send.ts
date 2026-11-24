export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};
export type SendEmail = (message: EmailMessage) => Promise<void>;

export type EmailDelivery = {
  baseURL: string;
  send: SendEmail;
};

export type EmailNotificationStatus = "sent" | "failed" | "none";

/** The part of the Workers `send_email` binding this feature uses. */
export type EmailBinding = {
  send(message: EmailMessage & { from: string }): Promise<unknown>;
};

/** Sends through the Worker's `send_email` binding. Delivery errors reject. */
export async function sendEmail(binding: EmailBinding, message: EmailMessage) {
  await binding.send({ from: "noreply@texfolia.com", ...message });
}

export function createEmailDelivery(
  binding: EmailBinding | undefined,
  baseURL: string | undefined,
): EmailDelivery | undefined {
  if (!binding || !baseURL) return undefined;
  return {
    baseURL,
    send: (message) => sendEmail(binding, message),
  };
}

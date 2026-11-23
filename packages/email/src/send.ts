export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};
export type SendEmail = (message: EmailMessage) => Promise<void>;

/** The part of the Workers `send_email` binding this package uses. */
export type EmailBinding = {
  send(message: EmailMessage & { from: string }): Promise<unknown>;
};

/** Sends through the Worker's `send_email` binding. Delivery errors reject. */
export async function sendEmail(binding: EmailBinding, message: EmailMessage) {
  await binding.send({ from: "noreply@texfolia.com", ...message });
}

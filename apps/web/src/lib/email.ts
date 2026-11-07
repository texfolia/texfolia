import { env } from "cloudflare:workers";

export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  try {
    await env.EMAIL.send({
      from: "noreply@texfolia.com",
      ...options,
    });
  } catch (e: any) {
    console.error("Failed to send email:", e.code, e.message);
  }
}

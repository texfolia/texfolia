import { env } from "cloudflare:workers";

export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  await env.EMAIL.send({
    from: "noreply@texfolia.com",
    ...options,
  });
}

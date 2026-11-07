export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const { env } = await import("cloudflare:workers");

  return env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: "Texfolia" },
    ...message,
  });
}

import { z } from "zod";

const verificationSchema = z.object({
  success: z.literal(true),
  action: z.literal("login"),
  hostname: z.string(),
});

export async function verifyLoginTurnstile(headers: Headers) {
  const token = headers.get("x-captcha-response");
  const secret = process.env.TURNSTILE_SECRET;
  const hostnames = new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim())
      .filter(Boolean),
  );

  if (
    !token ||
    token.length > 2048 ||
    !secret ||
    hostnames.size === 0 ||
    (process.env.NODE_ENV === "production" &&
      (hostnames.has("localhost") || hostnames.has("127.0.0.1")))
  ) {
    return false;
  }

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ secret, response: token }),
      },
    );
    if (!response.ok) return false;

    const result = verificationSchema.safeParse(await response.json());
    return result.success && hostnames.has(result.data.hostname);
  } catch {
    return false;
  }
}

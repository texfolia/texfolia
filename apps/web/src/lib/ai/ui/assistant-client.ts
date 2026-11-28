import { z } from "zod";

const errorSchema = z.object({ error: z.string() });

/** The server's message, or a general one. */
export function responseError(body: unknown, fallback: string) {
  const parsed = errorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : fallback;
}

export function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

export async function assistantJson(
  url: string,
  action?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(
    url,
    action
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
          signal,
        }
      : { signal },
  );
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error(responseError(body, "Could not load chats. Try again."));
  return body;
}

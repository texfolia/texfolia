const timeoutMs = 5_000;

/** Answers for uptime monitors: 503 unless the database answers in time. */
export async function checkHealth(
  queryDatabase: () => Promise<unknown>,
  timeout = timeoutMs,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let database = true;
  try {
    await Promise.race([
      queryDatabase(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The database did not answer in time")),
          timeout,
        );
      }),
    ]);
  } catch (error) {
    // The response is public, so only the log says why.
    console.error("Health check failed", error);
    database = false;
  } finally {
    clearTimeout(timer);
  }
  return Response.json(
    { status: database ? "ok" : "unavailable" },
    {
      status: database ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

// How the rest of the app reaches a project's builds.

/** The `BUILDS` Durable Object namespace as a fetcher of `/projects/<id>/...`. */
export function buildsFetcher(
  namespace: Pick<Env["BUILDS"], "getByName">,
): Pick<Fetcher, "fetch"> {
  return {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const projectId = url.pathname.split("/")[2] ?? "";
      return namespace.getByName(projectId).fetch(url.href, init);
    },
  };
}

/** Who a live response is for. It ends when they lose access to the project. */
export const liveUserHeader = "X-Live-User";

/**
 * Opens a project's build snapshots as a WebSocket upgrade. `userId` is null for
 * the app's own reads. There is no timeout: a signal would also end the socket.
 */
export async function connectBuilds(
  projectId: string,
  userId: string | null,
  builds?: Pick<Fetcher, "fetch">,
) {
  const fetcher =
    builds ?? buildsFetcher((await import("cloudflare:workers")).env.BUILDS);
  return fetcher.fetch(
    new URL(
      `/projects/${encodeURIComponent(projectId)}/events`,
      "http://builds",
    ),
    {
      headers: {
        Upgrade: "websocket",
        ...(userId === null ? {} : { [liveUserHeader]: userId }),
      },
    },
  );
}

/** Requests a project's builds. Paths start with `/projects/<projectId>`. */
export async function fetchBuilds(
  path: string,
  init?: RequestInit,
  builds?: Pick<Fetcher, "fetch">,
) {
  const fetcher =
    builds ?? buildsFetcher((await import("cloudflare:workers")).env.BUILDS);
  return fetcher.fetch(new URL(path, "http://builds"), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
}

/**
 * Marks a project's build stale after its sources changed. The change is already
 * committed, so a failure is only logged.
 */
export async function invalidateSourceBuild(
  projectId: string,
  builds?: Pick<Fetcher, "fetch">,
) {
  try {
    const response = await fetchBuilds(
      `/projects/${projectId}/changed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Not an editor's change, so it has no editor version.
        body: "{}",
      },
      builds,
    );
    if (!response.ok)
      throw new Error(`Build invalidation returned ${response.status}`);
  } catch (error) {
    console.error("Source committed but build invalidation failed", {
      projectId,
      error,
    });
  }
}

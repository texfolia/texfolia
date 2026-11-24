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

export async function fetchCompiler(path: string, init?: RequestInit) {
  const options: RequestInit = {
    ...init,
    redirect: "manual",
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  };
  const response = import.meta.env.DEV
    ? await fetch(
        new URL(path, process.env.COMPILER_URL ?? "http://localhost:8080"),
        options,
      )
    : await (
        await import("cloudflare:workers")
      ).env.COMPILER.fetch(new URL(path, "http://compiler"), options);
  if (response.status >= 300 && response.status < 400)
    throw new Error("Compiler returned an unexpected redirect");
  return response;
}

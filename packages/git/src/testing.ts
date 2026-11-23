// Test helpers for Bun: a local Git smart HTTP server backed by
// `git http-backend`, and a `git` command runner. Not for production code.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function gitCommand(...args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(stderr);
  return stdout.trim();
}

export async function gitServer() {
  const directory = await mkdtemp(join(tmpdir(), "texfolia-git-"));
  const backend = join(await gitCommand("--exec-path"), "git-http-backend");
  await readFile(backend);
  const requests: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
      });
      if (
        request.headers.get("authorization") !==
        `Basic ${btoa("oauth2:private-token")}`
      )
        return new Response("Denied", { status: 401 });
      const body = new Uint8Array(await request.arrayBuffer());
      const child = Bun.spawn([backend], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: directory,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: "test",
          SERVER_PROTOCOL: "HTTP/1.1",
          GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        },
        stdin: body,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new Uint8Array(
        await new Response(child.stdout).arrayBuffer(),
      );
      await child.exited;
      const split = output.findIndex(
        (_, i) =>
          output[i] === 13 &&
          output[i + 1] === 10 &&
          output[i + 2] === 13 &&
          output[i + 3] === 10,
      );
      if (split < 0)
        return new Response(await new Response(child.stderr).text(), {
          status: 500,
        });
      const headers = new Headers();
      let status = 200;
      for (const line of new TextDecoder()
        .decode(output.slice(0, split))
        .split("\r\n")) {
        const colon = line.indexOf(":");
        if (line.startsWith("Status:")) status = Number(line.slice(7, 10));
        else headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      return new Response(output.slice(split + 4), { headers, status });
    },
  });
  return {
    directory,
    origin: server.url.origin,
    requests,
    async create(name: string) {
      await gitCommand(
        "init",
        "--bare",
        "--initial-branch=main",
        join(directory, name),
      );
      await gitCommand(
        "--git-dir",
        join(directory, name),
        "config",
        "http.receivepack",
        "true",
      );
      return `${server.url.origin}/${name}`;
    },
    async close() {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

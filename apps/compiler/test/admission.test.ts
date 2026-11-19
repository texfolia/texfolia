import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { createLocalRuntime } from "../src/local";
import { unknownEngineTiming } from "../src/telemetry";

const source = { mainFile: "main.tex", files: { "main.tex": "hello" } };
const output = {
  pdf: new TextEncoder().encode("%PDF-1.5"),
  log: "ok",
  timing: { ...unknownEngineTiming, compileMs: 300_000 },
};
function submit(
  path: string,
  userId: string,
  plan = "free",
  id = crypto.randomUUID(),
) {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Compilation-Id": id,
      "X-Compile-User": userId,
      "X-Compile-Plan": plan,
    },
    body: JSON.stringify(source),
  });
}
async function completed(
  runtime: ReturnType<typeof createLocalRuntime>,
  path: string,
) {
  for (let i = 0; i < 300; i++) {
    const job = z
      .object({ status: z.string(), error: z.string().optional() })
      .parse(
        await (await runtime.fetch(new Request(`http://local${path}`))).json(),
      );
    if (job.status === "succeeded") return;
    if (job.status === "failed") throw new Error(job.error);
    await Bun.sleep(10);
  }
  throw new Error("Compilation did not complete");
}

test("Free rate limits follow user IDs across projects; paid users bypass them", async () => {
  const root = await mkdtemp(join(tmpdir(), "compile-admission-"));
  const engine = async () => ({
    ...output,
    timing: { ...output.timing, compileMs: 1 },
  });
  const runtime = createLocalRuntime({
    path: join(root, "state.sqlite"),
    projectEngine: () => engine,
  });
  try {
    const a = `/projects/${crypto.randomUUID()}/compile`,
      b = `/projects/${crypto.randomUUID()}/compile`,
      c = `/projects/${crypto.randomUUID()}/compile`;
    expect((await runtime.fetch(submit(a, "alice"))).status).toBe(202);
    expect((await runtime.fetch(submit(c, "alice"))).status).toBe(202);
    const denied = await runtime.fetch(submit(b, "alice"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("10");
    expect(await denied.json()).toEqual({
      error: "You're compiling quickly. Please try again in a few seconds.",
    });
    expect((await runtime.fetch(submit(b, "bob"))).status).toBe(202);
    for (const plan of ["pro", "team"]) {
      for (let i = 0; i < 4; i++)
        expect((await runtime.fetch(submit(b, plan, plan))).status).toBe(202);
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fair use is shared across projects, logged, and survives runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "compile-fair-use-"));
  const path = join(root, "state.sqlite");
  const engine = async () => output;
  const options = { path, projectEngine: () => engine };
  let runtime = createLocalRuntime(options);
  const log = spyOn(console, "info");
  try {
    const project = `/projects/${crypto.randomUUID()}`,
      other = `/projects/${crypto.randomUUID()}`,
      first = crypto.randomUUID(),
      second = crypto.randomUUID();
    expect(
      (await runtime.fetch(submit(`${project}/compile`, "alice", "pro", first)))
        .status,
    ).toBe(202);
    await completed(runtime, `${project}/jobs/${first}`);
    expect(
      (await runtime.fetch(submit(`${other}/compile`, "alice", "pro", second)))
        .status,
    ).toBe(202);
    await completed(runtime, `${other}/jobs/${second}`);
    await runtime.close();
    runtime = createLocalRuntime(options);
    const denied = await runtime.fetch(
      submit(`${project}/compile`, "alice", "pro"),
    );
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(3500);
    expect(await denied.json()).toEqual({
      error:
        "You've been compiling frequently. Please try again in a little while.",
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "compile_fair_use_hit",
        userId: "alice",
        plan: "pro",
      }),
    );
    expect(
      (await runtime.fetch(submit(`${project}/compile`, "bob", "pro"))).status,
    ).toBe(202);
  } finally {
    log.mockRestore();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

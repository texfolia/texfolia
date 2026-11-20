import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unknownEngineTiming } from "@texfolia/contracts";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import { createLocalRuntime } from "../src/local";
import type { Engine } from "../src/types";

const output = (source: string) => ({
  pdf: new TextEncoder().encode(`%PDF-${source}`),
  log: source,
  timing: unknownEngineTiming,
});
const source = (text: string) => ({
  mainFile: "main.tex",
  files: { "main.tex": text },
});
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
) {
  const deadline = Date.now() + 4000;
  while (true) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

function request(path: string, init?: RequestInit) {
  return new Request(`http://local${path}`, init);
}
function submit(
  runtime: ReturnType<typeof createLocalRuntime>,
  projectId: string,
  id: string,
  text: string,
) {
  return runtime.fetch(
    request(`/projects/${projectId}/compile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Compilation-Id": id,
        "X-Compile-User": "coordinator-user",
        "X-Compile-Plan": "pro",
      },
      body: JSON.stringify(source(text)),
    }),
  );
}

test("rapid revisions debounce; cancelled engines settle before replacement; late PDF cannot win", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-"));
  const firstStarted = Promise.withResolvers<void>();
  const cancellation = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runs: string[] = [];
  let active = 0;
  let maxActive = 0;
  const engine: Engine = async (project, context) => {
    const text = String(project.files["main.tex"]);
    runs.push(text);
    maxActive = Math.max(maxActive, ++active);
    if (text === "first") {
      firstStarted.resolve();
      context.signal?.addEventListener("abort", () => cancellation.resolve());
      // Simulate a late response from an engine that takes time to stop.
      await release.promise;
    }
    active--;
    return output(text);
  };
  const runtime = createLocalRuntime({
    path: join(root, "state.sqlite"),
    projectEngine: () => engine,
  });
  const projectId = crypto.randomUUID();
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  try {
    const stream = await runtime.fetch(
      request(`/projects/${projectId}/events`),
    );
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"revision":0',
    );
    expect((await submit(runtime, projectId, ids[0]!, "first")).status).toBe(
      202,
    );
    await firstStarted.promise;
    expect((await submit(runtime, projectId, ids[1]!, "discard")).status).toBe(
      202,
    );
    await cancellation.promise;
    expect(
      (await submit(runtime, projectId, ids[2]!, "discard too")).status,
    ).toBe(202);
    expect((await submit(runtime, projectId, ids[3]!, "newest")).status).toBe(
      202,
    );
    await Bun.sleep(400);
    expect(runs).toEqual(["first"]);
    release.resolve();
    const state = await eventually(
      async () =>
        coordinatorSnapshotSchema.parse(
          await (await runtime.fetch(request(`/projects/${projectId}`))).json(),
        ),
      (value) => value.current?.status === "succeeded",
    );
    expect(state).toMatchObject({
      revision: 4,
      latestBuild: { id: ids[3], revision: 4, status: "succeeded" },
    });
    expect(runs).toEqual(["first", "newest"]);
    expect(maxActive).toBe(1);
    expect(
      (
        await runtime.fetch(
          request(`/projects/${projectId}/compilations/${ids[0]}.pdf`),
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await runtime.fetch(
          request(`/projects/${projectId}/compilations/${ids[3]}.pdf`),
        )
      ).text(),
    ).toBe("%PDF-newest");
    expect((await submit(runtime, projectId, ids[3]!, "changed")).status).toBe(
      409,
    );
    expect((await submit(runtime, projectId, ids[3]!, "newest")).status).toBe(
      202,
    );
    await reader.cancel();
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("project engines run independently and durable snapshots resume after a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-"));
  const path = join(root, "state.sqlite");
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const jobA = crypto.randomUUID(),
    jobB = crypto.randomUUID();
  const owners: string[] = [];
  const started = new Set<string>();
  const together = Promise.withResolvers<void>();
  const projectEngine =
    (owner: string): Engine =>
    async (project, context) => {
      expect(context.projectId).toBe(owner);
      owners.push(owner);
      started.add(owner);
      if (started.size === 2) together.resolve();
      await together.promise;
      return output(String(project.files["main.tex"]));
    };
  const first = createLocalRuntime({ path, projectEngine });
  await submit(first, a, jobA, "a");
  await submit(first, b, jobB, "b");
  // Shutdown before the debounce fires. Reopening must recover both pending snapshots.
  await first.close();
  const restarted = createLocalRuntime({ path, projectEngine });
  try {
    await eventually(
      async () =>
        coordinatorSnapshotSchema.parse(
          await (await restarted.fetch(request(`/projects/${a}`))).json(),
        ),
      (value) => value.current?.status === "succeeded",
    );
    await eventually(
      async () =>
        coordinatorSnapshotSchema.parse(
          await (await restarted.fetch(request(`/projects/${b}`))).json(),
        ),
      (value) => value.current?.status === "succeeded",
    );
    expect(owners.sort()).toEqual([a, b].sort());
    expect(
      (
        await restarted.fetch(
          request(`/projects/${a}/compilations/${jobB}.pdf`),
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await restarted.fetch(
          request(`/projects/${a}/compilations/${jobA}.pdf`),
        )
      ).text(),
    ).toBe("%PDF-a");
  } finally {
    together.resolve();
    await restarted.close();
  }
  const reopened = createLocalRuntime({ path, projectEngine });
  expect(
    coordinatorSnapshotSchema.parse(
      await (await reopened.fetch(request(`/projects/${a}`))).json(),
    ).latestBuild?.id,
  ).toBe(jobA);
  await reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("out-of-order editor requests cannot replace a newer source revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-order-"));
  const path = join(root, "state.sqlite");
  const projectId = crypto.randomUUID(),
    editorId = crypto.randomUUID();
  const engine: Engine = async (project) =>
    output(String(project.files["main.tex"]));
  const submitVersion = (
    runtime: ReturnType<typeof createLocalRuntime>,
    sequence: number,
  ) =>
    runtime.fetch(
      request(`/projects/${projectId}/compile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Editor-Id": editorId,
          "X-Editor-Sequence": String(sequence),
        },
        body: JSON.stringify(source(String(sequence))),
      }),
    );
  const first = createLocalRuntime({
    path,
    projectEngine: () => engine,
  });
  expect((await submitVersion(first, 2)).status).toBe(202);
  expect((await submitVersion(first, 1)).status).toBe(409);
  await first.close();
  const restarted = createLocalRuntime({
    path,
    projectEngine: () => engine,
  });
  try {
    expect((await submitVersion(restarted, 1)).status).toBe(409);
    const state = coordinatorSnapshotSchema.parse(
      await (await restarted.fetch(request(`/projects/${projectId}`))).json(),
    );
    expect(state.revision).toBe(1);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

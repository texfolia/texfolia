import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import type { Engine } from "../src/jobs";
import { createLocalRuntime } from "../src/local";
import { HttpError } from "../src/project";
import { unknownEngineTiming } from "../src/telemetry";

const timing = {
  ...unknownEngineTiming,
  engine: "tectonic",
  compileMs: 10,
} as const;
const encode = (text: string) => new Blob([text]);
const output = (text: string) => ({
  pdf: new TextEncoder().encode(`%PDF-${text}`),
  log: `log-${text}`,
  timing,
  files: {
    "main.pdf": encode(`%PDF-${text}`),
    "main.log": encode(`log-${text}`),
    "main.aux": encode(`aux-${text}`),
    "nested/custom.bin": new Blob([new Uint8Array([0, 1, 2, 255])]),
  },
});

test("shared latest build survives failure/restart, restores every cache file, and cleans old generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "builds-"));
  const path = join(root, "store.sqlite");
  const projectId = crypto.randomUUID();
  const calls: { text: string; cached: string[] }[] = [];
  const engine: Engine = async (project, context) => {
    const text = String(project.files["main.tex"]);
    calls.push({ text, cached: Object.keys(context.cache ?? {}).sort() });
    if (text === "broken")
      throw new HttpError(422, "Bad TeX", "new failure log", timing);
    if (text === "cache fails" && context.cache)
      throw new HttpError(422, "Bad cache", "bad cache", timing);
    return text === "foreign engine"
      ? { ...output(text), timing: { ...timing, engine: "texlive" } }
      : output(text);
  };
  let runtime = createLocalRuntime({
    path,
    engine,
    projectEngine: () => engine,
  });
  const request = (suffix: string, init?: RequestInit) =>
    runtime.fetch(
      new Request(`http://local/projects/${projectId}${suffix}`, init),
    );
  const snapshot = async () =>
    coordinatorSnapshotSchema.parse(await (await request("")).json());
  async function compile(text: string, clean = false) {
    const id = crypto.randomUUID();
    expect(
      (
        await request("/compile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Compilation-Id": id,
            "X-Build-User": "Ada",
            "X-Clean-Build": clean ? "1" : "0",
          },
          body: JSON.stringify({
            mainFile: "main.tex",
            files: { "main.tex": text },
          }),
        })
      ).status,
    ).toBe(202);
    for (let count = 0; count < 200; count++) {
      const state = await snapshot();
      if (
        state.current?.id === id &&
        ["succeeded", "failed"].includes(state.current.status)
      )
        return state;
      await Bun.sleep(10);
    }
    throw new Error("Compile did not finish");
  }
  const file = (path: string) =>
    request(`/build/files?path=${encodeURIComponent(path)}`);
  try {
    let good = await compile("first");
    expect(good.artifacts).toMatchObject({
      builtBy: "Ada",
      engine: "tectonic",
      revision: 1,
    });
    expect(good.artifacts?.files.map((file) => file.path).sort()).toEqual([
      "main.aux",
      "main.log",
      "main.pdf",
      "nested/custom.bin",
    ]);
    expect(
      new Uint8Array(await (await file("nested/custom.bin")).arrayBuffer()),
    ).toEqual(new Uint8Array([0, 1, 2, 255]));
    const refreshing = compile("first");
    await Bun.sleep(10);
    expect((await snapshot()).stale).toBe(false);
    good = await refreshing;
    const firstId = good.artifacts!.id;
    const failed = await compile("broken");
    expect(failed.current?.status).toBe("failed");
    expect(failed.latestBuild?.id).toBe(firstId);
    expect(failed.stale).toBe(true);
    expect(await (await file("main.pdf")).text()).toBe("%PDF-first");
    expect(await (await file("main.aux")).text()).toBe("aux-first");
    expect(await (await file("main.log")).text()).toBe("new failure log");
    expect(
      calls
        .filter((call) => call.text === "broken")
        .map((call) => call.cached.length),
    ).toEqual([4, 0]);
    expect(
      (await request("/build/files?path=../../other-project/main.pdf")).status,
    ).toBe(404);
    expect(
      (await request("/build/files?path=main.pdf&version=old")).status,
    ).toBe(404);
    expect(
      (await request("/build/files?path=main.aux", { method: "DELETE" }))
        .status,
    ).toBe(404);
    await runtime.close();
    runtime = createLocalRuntime({ path, engine, projectEngine: () => engine });
    expect(await (await file("main.pdf")).text()).toBe("%PDF-first");
    await compile("recovered");
    expect(calls.at(-1)?.cached).toEqual([]);
    const second = await compile("cache fails");
    expect(second.current?.status).toBe("succeeded");
    expect(second.stale).toBe(false);
    expect(
      calls
        .filter((call) => call.text === "cache fails")
        .map((call) => call.cached.length),
    ).toEqual([4, 0]);
    expect((await request(`/compilations/${firstId}.pdf`)).status).toBe(404);
    await compile("clean", true);
    expect(calls.at(-1)).toEqual({ text: "clean", cached: [] });
    await compile("foreign engine");
    await compile("after engine change");
    expect(calls.at(-1)?.cached).toEqual([]);
    await runtime.close();
    const db = new Database(path, { readonly: true });
    const artifacts = db
      .query<{ key: string }, []>(
        "SELECT key FROM objects WHERE key LIKE '%/builds/%'",
      )
      .all();
    expect(artifacts).toHaveLength(4);
    db.close();
    runtime = createLocalRuntime({ path, engine, projectEngine: () => engine });
    expect((await request("/build", { method: "DELETE" })).status).toBe(204);
    expect((await snapshot()).artifacts).toBeNull();
    expect((await file("main.pdf")).status).toBe(404);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("collaborator edits before and during a build mark it stale; older notifications cannot stale a current build", async () => {
  const root = await mkdtemp(join(tmpdir(), "stale-build-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const engine: Engine = async () => {
    started.resolve();
    await release.promise;
    return output("good");
  };
  const runtime = createLocalRuntime({
    path: join(root, "state.sqlite"),
    engine,
    projectEngine: () => engine,
  });
  const projectId = crypto.randomUUID();
  const editorId = crypto.randomUUID();
  const request = (suffix: string, init?: RequestInit) =>
    runtime.fetch(
      new Request(`http://local/projects/${projectId}${suffix}`, init),
    );
  const snapshot = async () =>
    coordinatorSnapshotSchema.parse(await (await request("")).json());
  const changed = (sequence: number) =>
    request("/changed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editorId, sequence }),
    });
  try {
    await changed(1);
    expect((await snapshot()).stale).toBe(true);
    await request("/compile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Editor-Id": editorId,
        "X-Editor-Sequence": "2",
      },
      body: JSON.stringify({ files: { "main.tex": "good" } }),
    });
    await started.promise;
    await changed(3);
    release.resolve();
    for (
      let count = 0;
      count < 200 && (await snapshot()).current?.status !== "succeeded";
      count++
    )
      await Bun.sleep(10);
    expect((await snapshot()).stale).toBe(true);
    await request("/compile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Editor-Id": editorId,
        "X-Editor-Sequence": "4",
      },
      body: JSON.stringify({ files: { "main.tex": "good" } }),
    });
    for (
      let count = 0;
      count < 200 && (await snapshot()).current?.status !== "succeeded";
      count++
    )
      await Bun.sleep(10);
    expect((await snapshot()).stale).toBe(false);
    await changed(3);
    expect((await snapshot()).stale).toBe(false);
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("publication stays atomic through a storage failure; retention removes abandoned and active artifacts", async () => {
  const { ProjectCoordinatorCore } = await import("../src/coordinator");
  const objects = new Map<string, Uint8Array>();
  const persisted: { value: string | null } = { value: null };
  const pause = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  let fail = true;
  const store: import("../src/jobs").ObjectStore = {
    async read(key) {
      const data = objects.get(key);
      return data ? new Response(data).body : null;
    },
    async head(key) {
      const data = objects.get(key);
      return data ? { size: data.length } : null;
    },
    async create(key, value) {
      if (key.includes("/builds/") && ++writes === 2 && fail) {
        pause.resolve();
        await release.promise;
        throw new Error("Storage unavailable");
      }
      if (objects.has(key)) return false;
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
      return true;
    },
    async write(key, value) {
      objects.set(key, new TextEncoder().encode(value));
    },
    async remove(key) {
      objects.delete(key);
    },
    async *keys(prefix) {
      for (const key of objects.keys()) if (key.startsWith(prefix)) yield key;
    },
  };
  const options = {
    projectId: crypto.randomUUID(),
    saved: null,
    save: (value: string) => {
      persisted.value = value;
    },
    schedule: async () => {},
    overflow: async () => {},
    store,
    engine: async () => output("atomic"),
  };
  const core = new ProjectCoordinatorCore(options);
  try {
    const id = crypto.randomUUID();
    await core.submit(
      id,
      { mainFile: "main.tex", files: { "main.tex": "atomic" } },
      "free",
    );
    await Bun.sleep(310);
    const running = core.wake();
    await pause.promise;
    expect(core.snapshot().artifacts).toBeNull();
    expect(await core.artifact(id)).toBeNull();
    release.resolve();
    await running;
    expect(core.snapshot().artifacts).toBeNull();
    expect(core.snapshot().current).toMatchObject({ status: "failed" });
    fail = false;
    await core.submit(
      crypto.randomUUID(),
      { mainFile: "main.tex", files: { "main.tex": "atomic" } },
      "free",
    );
    await Bun.sleep(310);
    await core.wake();
    expect(core.snapshot().artifacts?.files).toHaveLength(4);
    expect(
      [...objects.keys()].filter((key) => key.includes("/builds/")),
    ).toHaveLength(4);
    const saved = JSON.parse(persisted.value!);
    saved.lastActivity = Date.now() - 31 * 24 * 60 * 60_000;
    const expired = new ProjectCoordinatorCore({
      ...options,
      saved: JSON.stringify(saved),
    });
    await expired.wake();
    expect(expired.snapshot().artifacts).toBeNull();
    expect(objects.size).toBe(0);
    await expired.close();
  } finally {
    release.resolve();
    await core.close();
  }
});

test("the first failed compile exposes its full log without inventing a PDF", async () => {
  const root = await mkdtemp(join(tmpdir(), "first-failure-"));
  const rawLog = "full TeX log\n".repeat(10_000);
  const engine: Engine = async () => {
    throw new HttpError(422, "Bad TeX", "bounded summary", timing, {
      path: "main.log",
      base64: btoa(rawLog),
    });
  };
  const runtime = createLocalRuntime({
    path: join(root, "state.sqlite"),
    engine,
    projectEngine: () => engine,
  });
  const projectId = crypto.randomUUID();
  const request = (suffix: string, init?: RequestInit) =>
    runtime.fetch(
      new Request(`http://local/projects/${projectId}${suffix}`, init),
    );
  try {
    await request("/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: { "main.tex": "bad" } }),
    });
    let state;
    for (let count = 0; count < 200; count++) {
      state = coordinatorSnapshotSchema.parse(await (await request("")).json());
      if (state.current?.status === "failed") break;
      await Bun.sleep(10);
    }
    expect(state?.latestBuild).toBeNull();
    expect(state?.artifacts?.pdf).toBeNull();
    expect(await (await request("/build/files?path=main.log")).text()).toBe(
      rawLog,
    );
    expect((await request("/build/files?path=main.pdf")).status).toBe(404);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

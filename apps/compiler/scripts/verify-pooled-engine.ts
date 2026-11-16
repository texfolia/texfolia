import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import { createEngineClient } from "../src/engine";
import { createLocalRuntime } from "../src/local";
import { createLocalContainerPool } from "../src/local-containers";
import type { EngineTiming } from "../src/telemetry";

const directory = await mkdtemp(join(tmpdir(), "texfolia-pool-check-"));
const options = {
  path: join(directory, "pool.sqlite"),
  socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  image: process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
};
let pool = createLocalContainerPool(options);
const open = () =>
  createLocalRuntime({
    path: join(directory, "compiler.sqlite"),
    engine: createEngineClient((request) => fetch(request)),
    projectEngine: pool.projectEngine,
  });
let runtime = open();
const a = crypto.randomUUID(),
  b = crypto.randomUUID();
const user = crypto.randomUUID();
const observations: { container: string; timing: EngineTiming }[] = [];

async function compile(projectId: string, text: string, clean = false) {
  const id = crypto.randomUUID();
  const files =
    projectId === a
      ? {
          "main.tex": String.raw`\documentclass{article}\begin{document}\input{private-a.tex}\end{document}`,
          "private-a.tex": text,
        }
      : {
          "main.tex":
            String.raw`\documentclass{article}\begin{document}\IfFileExists{private-a.tex}{\undefinedcommand}{}` +
            text +
            String.raw`\end{document}`,
        };
  const response = await runtime.fetch(
    new Request(`http://local/projects/${projectId}/compile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Compilation-Id": id,
        "X-Compile-Plan": "pro",
        "X-Compile-User": user,
        ...(clean ? { "X-Clean-Build": "1" } : {}),
      },
      body: JSON.stringify({ mainFile: "main.tex", files }),
    }),
  );
  assert.equal(response.status, 202, await response.text());
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const snapshot = coordinatorSnapshotSchema.parse(
      await (
        await runtime.fetch(new Request(`http://local/projects/${projectId}`))
      ).json(),
    );
    if (snapshot.current?.id === id && snapshot.current.status === "failed")
      throw new Error(`${snapshot.current.error}\n${snapshot.current.log}`);
    if (
      snapshot.current?.id === id &&
      snapshot.current.status === "succeeded"
    ) {
      const pdf = await runtime.fetch(
        new Request(
          `http://local/projects/${projectId}/compilations/${id}.pdf`,
        ),
      );
      assert.equal(pdf.status, 200);
      assert((await pdf.text()).startsWith("%PDF-"));
      const inventory = pool.snapshot();
      assert.equal(inventory.leases.length, 0);
      assert.equal(inventory.spares.length, 1);
      const spare = inventory.spares[0];
      assert(spare);
      const container = `texfolia-${spare.name.replaceAll(":", "-")}`;
      const leftovers = execFileSync(
        "docker",
        [
          "exec",
          container,
          "find",
          "/tmp",
          "-maxdepth",
          "1",
          "-name",
          "texfolia-*",
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        leftovers.trim(),
        "",
        "Project temporary files survived lease release",
      );
      assert(snapshot.current.timing);
      observations.push({ container, timing: snapshot.current.timing });
      return snapshot.current.timing;
    }
    await Bun.sleep(20);
  }
  throw new Error("Pooled compilation did not finish");
}

try {
  await compile(a, "Private A first.");
  await compile(b, "Public B first.");
  const restored = await compile(a, "Private A second.");
  assert.equal(restored.archiveStatus, "restored");
  assert.equal(restored.cacheUsed, true);
  assert.equal(restored.temperature, "warm");
  await runtime.close();
  await pool.close();
  pool = createLocalContainerPool(options);
  runtime = open();
  const afterRestart = await compile(b, "Public B second.");
  assert.equal(afterRestart.archiveStatus, "restored");
  const clean = await compile(a, "Private A clean.", true);
  assert.equal(clean.cacheUsed, false);
  assert.equal(clean.archiveBytes, 0);
  assert.equal(new Set(observations.map((entry) => entry.container)).size, 1);
  assert.equal(
    new Set(observations.map((entry) => entry.timing.containerBootId)).size,
    1,
  );
  console.info(
    "Verified real Tectonic: A/B/A container reuse, cache restore, clean bypass, workdir cleanup, and pool restart recovery.",
  );
} finally {
  await runtime.close();
  await pool.close({ removeContainers: true });
  await rm(directory, { recursive: true, force: true });
}

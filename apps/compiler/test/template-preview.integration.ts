import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { templateStarters } from "../../web/src/lib/template-starters";
import { createEngineClient } from "../src/engine";
import { createLocalRuntime } from "../src/local";

const engineUrl = process.env.ENGINE_URL;
assert(
  engineUrl,
  "Set ENGINE_URL to a local compile container with pdftoppm installed",
);
const directory = await mkdtemp(
  join(tmpdir(), "texfolia-preview-integration-"),
);
const engine = createEngineClient((request) => fetch(request), engineUrl);
const runtime = createLocalRuntime({
  path: join(directory, "jobs.sqlite"),
  engine,
  projectEngine: () => engine,
});
try {
  for (const starter of templateStarters) {
    const id = crypto.randomUUID();
    const submitted = await runtime.fetch(
      new Request("http://local/compile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Compilation-Id": id,
          "X-Compile-Plan": "free",
        },
        body: JSON.stringify({
          mainFile: "main.tex",
          files: { "main.tex": starter.source },
          preview: true,
        }),
      }),
    );
    assert.equal(submitted.status, 202);
    const deadline = Date.now() + 60_000;
    while (true) {
      const status = await (
        await runtime.fetch(new Request(`http://local/jobs/${id}`))
      ).json();
      assert(status && typeof status === "object" && "status" in status);
      assert.notEqual(status.status, "failed", JSON.stringify(status));
      if (status.status === "succeeded") break;
      assert(Date.now() < deadline, "Preview compilation timed out");
      await Bun.sleep(250);
    }
    const response = await runtime.fetch(
      new Request(`http://local/compilations/${id}.png`),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    const image = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(
      image.slice(0, 8),
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const dimensions = new DataView(image.buffer, image.byteOffset);
    assert.equal(
      Math.max(dimensions.getUint32(16), dimensions.getUint32(20)),
      1200,
    );
    assert(
      (await runtime.fetch(new Request(`http://local/compilations/${id}.pdf`)))
        .ok,
    );
    console.log(
      `${starter.title}: real container compile → persisted PDF + ${image.byteLength}-byte first-page PNG`,
    );
  }
} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}

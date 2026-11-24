import assert from "node:assert/strict";

import { templateStarters } from "@texfolia/db/template-starters";

import { compileSuccessfully } from "../scripts/engine-client";

assert(
  process.env.ENGINE_URL,
  "Set ENGINE_URL to a local compile container with pdftoppm installed",
);
for (const starter of templateStarters) {
  const { preview, pdf } = await compileSuccessfully({
    files: { "main.tex": starter.source },
    preview: true,
  });
  assert(preview);
  assert.deepEqual(
    preview.slice(0, 8),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const dimensions = new DataView(preview.buffer, preview.byteOffset);
  assert.equal(
    Math.max(dimensions.getUint32(16), dimensions.getUint32(20)),
    1200,
  );
  console.log(
    `${starter.title}: real container compile → ${pdf.length}-byte PDF + ${preview.length}-byte first-page PNG`,
  );
}

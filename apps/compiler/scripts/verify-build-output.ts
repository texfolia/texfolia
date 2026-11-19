import { mkdir, writeFile } from "node:fs/promises";

import { encodeBase64 } from "../src/artifacts";
import { createEngineClient } from "../src/engine";
import { HttpError } from "../src/project";
import type { Engine } from "../src/types";

const engine = createEngineClient(
  (request) => fetch(request),
  process.env.ENGINE_URL ?? "http://127.0.0.1:8081",
);
const context = () => ({
  jobId: crypto.randomUUID(),
  attempt: 1,
  plan: "free" as const,
});
const first = await engine(
  {
    mainFile: "main.tex",
    files: {
      "main.tex": String.raw`\documentclass{article}\begin{document}
\newwrite\generated\immediate\openout\generated=generated.tex
\immediate\write\generated{Hello from generated output.}\immediate\closeout\generated
Generated a file.\end{document}`,
    },
  },
  context(),
);
if (!first.files?.["generated.tex"])
  throw new Error("Arbitrary generated file is missing");
const cache: NonNullable<Parameters<Engine>[1]["cache"]> = {};
for (const [path, blob] of Object.entries(first.files))
  cache[path] = {
    base64: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
  };
const second = await engine(
  {
    mainFile: "main.tex",
    files: {
      "main.tex": String.raw`\documentclass{article}\begin{document}\input{out/generated.tex}\end{document}`,
    },
  },
  { ...context(), cache },
);
const nested = await engine(
  {
    mainFile: "src/main.tex",
    files: {
      "src/main.tex": String.raw`\documentclass{article}\begin{document}\input{out/generated.tex}\end{document}`,
    },
  },
  { ...context(), cache },
);
if (nested.pdf.length < 1000)
  throw new Error("Nested main file could not input out/ files");
const directory = process.env.RESULT_DIR ?? "/private/tmp/nat225-input";
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/generated-input.pdf`, second.pdf);
try {
  await engine(
    {
      mainFile: "main.tex",
      files: {
        "main.tex": String.raw`\documentclass{article}\begin{document}\undefinedcommand\end{document}`,
      },
    },
    context(),
  );
  throw new Error("Expected TeX failure");
} catch (error) {
  if (
    !(error instanceof HttpError) ||
    error.status !== 422 ||
    !error.logFile?.base64
  )
    throw error;
}
console.info(
  "Generated source, input from out/, binary multipart transport, and full failure log verified.",
);

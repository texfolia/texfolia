import { mkdir, writeFile } from "node:fs/promises";

import { compileOnEngine, compileSuccessfully } from "./engine-client";

const first = await compileSuccessfully({
  files: {
    "main.tex": String.raw`\documentclass{article}\begin{document}
\newwrite\generated\immediate\openout\generated=generated.tex
\immediate\write\generated{Hello from generated output.}\immediate\closeout\generated
Generated a file.\end{document}`,
  },
});
if (!first.files.has("generated.tex"))
  throw new Error("Arbitrary generated file is missing");
const { cache } = first;
const second = await compileSuccessfully({
  files: {
    "main.tex": String.raw`\documentclass{article}\begin{document}\input{out/generated.tex}\end{document}`,
  },
  cache,
});
const nested = await compileSuccessfully({
  mainFile: "src/main.tex",
  files: {
    "src/main.tex": String.raw`\documentclass{article}\begin{document}\input{out/generated.tex}\end{document}`,
  },
  cache,
});
if (nested.pdf.length < 1000)
  throw new Error("Nested main file could not input out/ files");
const directory = process.env.RESULT_DIR ?? "/tmp/texfolia-build-output";
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/generated-input.pdf`, second.pdf);
const failed = await compileOnEngine({
  files: {
    "main.tex": String.raw`\documentclass{article}\begin{document}\undefinedcommand\end{document}`,
  },
});
if (failed.status !== 422 || !failed.files.get("main.log")?.length)
  throw new Error("Expected a TeX failure with its full log");
console.info(
  "Generated source, input from out/, binary transport, and full failure log verified.",
);

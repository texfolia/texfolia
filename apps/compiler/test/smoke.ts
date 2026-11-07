// With the compiler running: bun run apps/compiler/test/smoke.ts
import { z } from "zod";

const base = process.env.COMPILER_URL ?? "http://localhost:8080";
const headers = new Headers({ "Content-Type": "application/json" });
const files = {
  "main.tex":
    "\\documentclass{article}\\begin{document}\\input{sections/hello}\\end{document}",
  "sections/hello.tex": "Hello from Texfolia!",
  "unused.txt": "x".repeat(150 * 1024),
};
const submitted = z.object({ id: z.uuid(), statusUrl: z.string() });
const outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("running") }),
  z.object({
    status: z.literal("succeeded"),
    artifactUrl: z.string(),
    sizeBytes: z.number(),
    log: z.string(),
  }),
  z.object({
    status: z.literal("failed"),
    errorStatus: z.number(),
    log: z.string(),
  }),
]);

async function compile(files: Record<string, string>) {
  const response = await fetch(new URL("/compile", base), {
    method: "POST",
    headers,
    body: JSON.stringify({ files }),
  });
  if (response.status !== 202)
    throw new Error(
      `Expected 202, got ${response.status}: ${await response.text()}`,
    );
  const job = submitted.parse(await response.json());
  if (response.headers.get("Location") !== job.statusUrl)
    throw new Error("Expected the job status URL in Location");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL(job.statusUrl, base), { headers });
    if (!response.ok) throw new Error(`Status returned ${response.status}`);
    const result = outcome.parse(await response.json());
    if (result.status === "succeeded" || result.status === "failed")
      return result;
    await Bun.sleep(500);
  }
  throw new Error(`Job ${job.id} did not finish`);
}

const valid = await compile(files);
if (valid.status !== "succeeded")
  throw new Error(`Valid LaTeX failed: ${valid.log}`);
const artifact = await fetch(new URL(valid.artifactUrl, base), { headers });
const pdf = Buffer.from(await artifact.arrayBuffer());
if (
  !artifact.ok ||
  artifact.headers.get("Content-Type") !== "application/pdf" ||
  !pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
  pdf.length !== valid.sizeBytes
)
  throw new Error("Expected PDF bytes and matching job size");
const invalid = await compile({ "main.tex": "\\invalidcommand" });
if (
  invalid.status !== "failed" ||
  invalid.errorStatus !== 422 ||
  !invalid.log.includes("invalidcommand")
)
  throw new Error("Expected a failed LaTeX job with diagnostics");
console.log(
  `Smoke passed: retrieved a ${pdf.length}-byte PDF and the invalid LaTeX diagnostics`,
);

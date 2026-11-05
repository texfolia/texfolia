// Run after docker compose up --build: bun run test/smoke.ts
const base = process.env.COMPILER_URL ?? "http://localhost:8080";
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.COMPILER_TOKEN)
  headers.Authorization = `Bearer ${process.env.COMPILER_TOKEN}`;
const files = {
  "main.tex":
    "\\documentclass{article}\\begin{document}\\input{sections/hello}\\end{document}",
  "sections/hello.tex": "Hello from Texfolia!",
};
const response = await fetch(`${base}/compile`, {
  method: "POST",
  headers,
  body: JSON.stringify({ files }),
});
if (!response.ok)
  throw new Error(`${response.status}: ${await response.text()}`);
const pdf = Buffer.from(await response.arrayBuffer());
if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")))
  throw new Error("Expected PDF bytes");
const invalid = await fetch(`${base}/compile`, {
  method: "POST",
  headers,
  body: JSON.stringify({ files: { "main.tex": "\\invalidcommand" } }),
});
if (invalid.status !== 422)
  throw new Error(`Expected LaTeX error, got ${invalid.status}`);
console.log(
  `Smoke passed: compiled ${pdf.length} PDF bytes and reported invalid LaTeX`,
);

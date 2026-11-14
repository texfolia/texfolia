import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { chromium, type Browser } from "playwright";

import type { FormatResponse } from "../src/lib/latex/format";

const client = new URL("../dist/client/", import.meta.url);
const assets = await readdir(new URL("assets/", client));
function asset(pattern: RegExp) {
  const name = assets.find((name) => pattern.test(name));
  assert(name, `Missing production asset: ${pattern}`);
  return `/assets/${name}`;
}
const styles = asset(/^styles-.*\.css$/);
const formatter = asset(/^format\.worker-.*\.js$/);
const pdf = asset(/^pdf\.worker\.min-.*\.mjs$/);
const cssFiles = assets.filter((name) => name.endsWith(".css"));
for (const name of cssFiles) {
  const url = new URL(`assets/${name}`, client);
  const css = await readFile(url, "utf8");
  for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    const reference = match[1];
    assert(reference);
    if (reference.startsWith("data:")) continue;
    const target = reference.startsWith("/")
      ? new URL(reference.slice(1), client)
      : new URL(reference, url);
    assert(await Bun.file(target).exists(), `Missing CSS asset: ${target}`);
  }
}
const javascript = (
  await Promise.all(
    assets
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(new URL(`assets/${name}`, client), "utf8")),
  )
).join("\n");
for (const worker of [formatter, pdf])
  assert(javascript.includes(worker), `Worker is not referenced: ${worker}`);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/pdfjs.mjs")
      return new Response(
        Bun.file(new URL(import.meta.resolve("pdfjs-dist/build/pdf.mjs"))),
      );
    if (pathname === "/")
      return new Response(
        `<!doctype html><link rel="stylesheet" href="${styles}"><body class="font-sans">Inter <code class="font-mono">LaTeX</code></body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    const file = Bun.file(new URL(`.${pathname}`, client));
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(request.url()));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(server.url.href);
  const fonts = await page.evaluate(async () => {
    const loaded = await document.fonts.load('16px "Inter Variable"');
    const code = document.querySelector("code");
    if (!code) throw new Error("Missing monospace font sample");
    return {
      loaded: loaded.length,
      sans: getComputedStyle(document.body).fontFamily,
      mono: getComputedStyle(code).fontFamily,
    };
  });
  assert(fonts.loaded > 0, "Inter font did not load");
  assert.match(fonts.sans, /Inter Variable/);
  assert.match(fonts.mono, /monospace/);

  const source = "\\begin{itemize}\n\\item Hello\n\\end{itemize}\n";
  const response = await page.evaluate(
    ({ formatter, source }) =>
      new Promise<FormatResponse>((resolve, reject) => {
        const worker = new Worker(formatter, { type: "module" });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Production formatter timed out"));
        }, 15_000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.message));
        };
        worker.onmessage = ({ data }: MessageEvent<FormatResponse>) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(data);
        };
        worker.postMessage({
          source,
          settings: { indent: 2, wrap: true, width: 80 },
        });
      }),
    { formatter, source },
  );
  assert(!("error" in response), JSON.stringify(response));
  let formatted = source;
  for (const change of [...response.changes].reverse())
    formatted =
      formatted.slice(0, change.from) +
      change.insert +
      formatted.slice(change.to);
  assert.equal(formatted, "\\begin{itemize}\n  \\item Hello\n\\end{itemize}\n");

  const pdfReady = await page.evaluate(
    async ({ pdf, library }) => {
      const pdfjs: typeof import("pdfjs-dist") = await import(library);
      pdfjs.GlobalWorkerOptions.workerSrc = pdf;
      const worker = new pdfjs.PDFWorker();
      try {
        await Promise.race([
          worker.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("PDF worker timed out")), 15_000),
          ),
        ]);
        return worker.port instanceof Worker;
      } finally {
        worker.destroy();
      }
    },
    { pdf, library: new URL("/pdfjs.mjs", server.url).href },
  );
  assert(pdfReady, "PDF.js did not initialize a real PDF worker");
  assert.deepEqual(errors, []);
  console.info(
    "Production CSS, Inter font, formatter JS/WASM, and PDF worker verified.",
  );
} finally {
  await browser?.close();
  await server.stop(true);
}

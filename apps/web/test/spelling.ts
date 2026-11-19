// Browser check for LaTeX-aware spellcheck: the spelling worker, lazily
// fetched Hunspell dictionary and CodeMirror diagnostics all run for real.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

import type { SpellingTest } from "./spelling/browser";

declare global {
  interface Window {
    spellingTest: SpellingTest;
  }
}

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const copy = Bun.spawnSync(["bun", "run", "scripts/copy-dictionaries.ts"], {
  cwd: webRoot,
  stdout: "inherit",
  stderr: "inherit",
});
assert.equal(copy.exitCode, 0, "Copying dictionaries failed");

const vite = await createServer({
  configFile: false,
  root: webRoot,
  logLevel: "warn",
  optimizeDeps: { entries: ["test/spelling/browser.tsx"] },
  plugins: [
    {
      name: "spelling-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/test/spelling/browser.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
  resolve: { alias: { "#": `${webRoot}src` } },
  server: { host: "127.0.0.1", port: 0 },
});

const browser = await chromium.launch({ headless: true });
try {
  await vite.listen();
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dictionaries: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dictionaries/")) dictionaries.push(path);
  });
  await page.goto(vite.resolvedUrls?.local[0] ?? "");

  const flagged = page.locator(".cm-lintRange.cm-spelling");
  await flagged.first().waitFor();
  assert.deepEqual(await flagged.allTextContents(), ["sentense", "Texfolia"]);
  assert.deepEqual(dictionaries.sort(), [
    "/dictionaries/en-US.aff",
    "/dictionaries/en-US.dic",
  ]);

  // Hovering shows suggestions; choosing one replaces the word.
  await flagged.first().hover();
  const suggestion = page
    .locator(".cm-tooltip-lint .cm-spellingSuggestions button")
    .filter({ hasText: /^sentence$/ });
  await suggestion.click();
  assert.match(
    await page.evaluate(() => window.spellingTest.text()),
    /This sentence has a mistake/,
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".cm-lintRange.cm-spelling").length === 1,
  );

  // Add to dictionary clears the diagnostic without editing the source.
  await page.mouse.move(0, 0);
  await flagged.first().hover();
  await page
    .locator(".cm-tooltip-lint button", { hasText: "Add to dictionary" })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".cm-lintRange.cm-spelling").length === 0,
  );
  assert.deepEqual(await page.evaluate(() => window.spellingTest.words()), [
    "Texfolia",
  ]);
  assert.deepEqual(errors, []);
  console.log("Spelling browser checks passed.");
} finally {
  await browser.close();
  await vite.close();
}

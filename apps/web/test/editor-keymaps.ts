import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { chromium, type Page } from "playwright";
import { createServer } from "vite";

import { emacsKeymap } from "../scripts/vite-emacs-keymap";

// Checks the Vim and Emacs keymaps in a real browser: switching without a
// reload, undo through the Yjs history, and app shortcuts yielding to them.
const root = fileURLToPath(new URL("../", import.meta.url));
const vite = await createServer({
  configFile: false,
  root,
  optimizeDeps: { entries: ["test/editor-keymaps/browser.tsx"] },
  plugins: [
    emacsKeymap(),
    {
      name: "keymap-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/test/editor-keymaps/browser.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
  resolve: { alias: { "#": `${root}src` } },
  server: { host: "127.0.0.1", port: 0, forwardConsole: false },
});

// The page exposes these on `window.keymapTest`.
type Fixture = {
  takeRuns: () => string[];
  text: () => string;
  select: (keymap: string) => void;
};
const call = <K extends keyof Fixture>(
  page: Page,
  name: K,
  ...args: Parameters<Fixture[K]>
) =>
  page.evaluate(
    ([name, args]) => {
      const test = (window as unknown as { keymapTest: Fixture }).keymapTest;
      return (test[name] as (...values: unknown[]) => unknown)(...args);
    },
    [name, args] as const,
  ) as Promise<ReturnType<Fixture[K]>>;

const browser = await chromium.launch({ headless: true });
try {
  await vite.listen();
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(vite.resolvedUrls?.local[0] ?? "");
  const content = page.locator(".cm-content");
  await content.waitFor();
  const text = () => call(page, "text");
  const runs = () => call(page, "takeRuns");
  const select = async (keymap: string) => {
    await call(page, "select", keymap);
    await page.locator(`.cm-editor[data-keymap="${keymap}"]`).waitFor();
    await content.focus();
  };

  // Default keys: app shortcuts own Ctrl+U and Ctrl+K sequences.
  await content.focus();
  await page.keyboard.press("Control+U");
  await page.keyboard.press("Control+K");
  await page.keyboard.press("S");
  assert.deepEqual(await runs(), ["underline", "saveWithoutCompiling"]);

  await select("vim");
  await page.keyboard.press("Escape");
  await page.keyboard.type("ggdd");
  assert.equal(await text(), "second line\nthird line", "Vim dd");
  await page.keyboard.type("u");
  assert.equal(
    await text(),
    "first line\nsecond line\nthird line",
    "Vim u undoes through the Yjs undo manager",
  );
  // Ctrl+U is Vim's half-page up, so Underline yields; Save and tab
  // switching keep their keys.
  await page.keyboard.press("Control+U");
  await page.keyboard.press("Control+S");
  await page.keyboard.press("Control+PageDown");
  assert.deepEqual(await runs(), ["save", "nextTab"]);
  // Outside the editor, Underline keeps its shortcut.
  await content.blur();
  await page.keyboard.press("Control+U");
  assert.deepEqual(await runs(), ["underline"]);

  // Switch again without reloading. Emacs's C-k kills the line instead of
  // starting Mod+K sequences, and C-/ undoes through Yjs.
  await select("emacs");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+K");
  assert.equal(await text(), "\nsecond line\nthird line", "Emacs C-k");
  await page.keyboard.press("Control+/");
  assert.equal(await text(), "first line\nsecond line\nthird line");
  await page.keyboard.press("Control+S");
  assert.deepEqual(await runs(), ["save"], "Save wins over Emacs C-s");

  await call(page, "select", "default");
  await page.locator(".cm-editor:not([data-keymap])").waitFor();
  assert.deepEqual(errors, []);
  console.log("Editor keymaps passed");
} finally {
  await browser.close();
  await vite.close();
}

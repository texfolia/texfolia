import assert from "node:assert/strict";

import { chromium, type Page } from "playwright";

import type { RuntimeTest } from "./editor-runtime/browser";
import {
  eventually,
  fixtureProject,
  startWorkspace,
} from "./editor-runtime/harness";
import { pdfFixture } from "./pdf-fixture";

declare global {
  interface Window {
    runtimeTest: RuntimeTest;
    startedWorkers: { url: string; terminated: boolean }[];
  }
}

// Runs the real workspace in a browser, against a fixture of its network.
const main = String.raw`\documentclass{article}
\begin{document}
\section{First}
\begin{itemize}
\item Main
\end{itemize}
\section{Second}
\end{document}
`;
const chapter = String.raw`\begin{itemize}
\item Chapter
\end{itemize}
`;
const { project, rootId, node } = fixtureProject("Editor runtime", [
  { name: "main.tex", text: main },
  { name: "chapter.tex", text: chapter },
]);
const projectId = project.id;
const mainNode = node("main.tex");
let pdfRequests = 0;
const workspace = await startWorkspace({
  project,
  pdf: () => {
    pdfRequests++;
    return pdfFixture();
  },
});
const { documents } = workspace;

const text = (page: Page) => page.evaluate(() => window.runtimeTest.text());
const workers = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      window.startedWorkers.filter(({ url }) => url.includes(name)).length,
    name,
  );
const layout = (page: Page) =>
  page.evaluate(
    (key) => localStorage.getItem(key) ?? "",
    `texfolia.workspace.layout.v1:runtime-test:${projectId}`,
  );

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  await page.addInitScript(() => {
    window.startedWorkers = [];
    const Native = Worker;
    window.Worker = class extends Native {
      private entry = { url: "", terminated: false };
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.entry.url = String(url);
        window.startedWorkers.push(this.entry);
      }
      override terminate() {
        this.entry.terminated = true;
        super.terminate();
      }
    };
  });
  await page.goto(workspace.url);
  const content = page.locator('.cm-content[contenteditable="true"]');
  await content.waitFor();
  const status = page.getByLabel("Workspace status");
  const sidebar = (name: string) =>
    page
      .getByRole("toolbar", { name: "Right sidebar views" })
      .getByRole("button", { name, exact: true });

  /** Runs a command of the Edit menu. */
  const menuCommand = async (name: string) => {
    await page
      .locator('[data-slot="menubar-trigger"]')
      .filter({ hasText: /^Edit$/ })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).focus();
    await page.keyboard.press("Enter");
  };
  /** Runs a command of the editor's context menu. */
  const contextCommand = async (name: string) => {
    await content.dispatchEvent("contextmenu", {
      button: 2,
      clientX: 400,
      clientY: 300,
    });
    await page.getByRole("menuitem", { name, exact: true }).focus();
    await page.keyboard.press("Enter");
  };

  console.info("Checking that typing only renders what shows it");
  await page.evaluate(() => window.runtimeTest.select(0));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.runtimeTest.takeRendered());
  for (let index = 0; index < 40; index++)
    await page.keyboard.press("ArrowRight");
  await status.getByText("Ln 2, Col 17").waitFor();
  const moved = await page.evaluate(() => window.runtimeTest.takeRendered());
  console.info(
    `40 cursor moves: ${moved.commits} commits, ${moved.ms.toFixed(1)} ms`,
  );
  // Rendering the workspace for each move takes several times this.
  assert(moved.ms < 100, "A moving cursor must not render the workspace");
  await page.evaluate(() => window.runtimeTest.select(0));
  await page.keyboard.type("% forty characters of ordinary typing xx", {
    delay: 10,
  });
  const typed = await page.evaluate(() => window.runtimeTest.takeRendered());
  console.info(
    `40 keystrokes: ${typed.commits} commits, ${typed.ms.toFixed(1)} ms`,
  );
  await page.keyboard.press("Enter");

  console.info("Checking undo across settings and access changes");
  await page.waitForTimeout(600);
  const before = await text(page);
  await page.keyboard.type("AAA");
  // Word wrap is a setting; it must not disturb the document's binding.
  const wrapped = () => page.locator(".cm-content.cm-lineWrapping").count();
  const wrapping = await wrapped();
  await menuCommand("Wrap lines");
  await eventually(async () => (await wrapped()) !== wrapping, true, "Wrap");
  await content.focus();
  await page.keyboard.press("Control+Z");
  await eventually(() => text(page), before, "Undo after a setting changes");
  project.canWrite = false;
  await page.evaluate(() => window.runtimeTest.refresh());
  await page.locator('.cm-content[contenteditable="false"]').waitFor();
  project.canWrite = true;
  await page.evaluate(() => window.runtimeTest.refresh());
  await content.waitFor();
  await page.evaluate(() => window.runtimeTest.select(0));
  await page.waitForTimeout(600);
  await page.keyboard.type("BBB");
  await eventually(
    async () => (await text(page)).startsWith("BBB"),
    true,
    "Typing after access returns",
  );
  await page.keyboard.press("Control+Z");
  await eventually(() => text(page), before, "Undo after access returns");
  await eventually(
    () => documents.get(mainNode.id)?.getText("source").toString(),
    before,
    "The room has the same text",
  );

  console.info("Checking cut and paste");
  await page.evaluate(() => window.runtimeTest.select(0, 7));
  await contextCommand("Cut");
  await eventually(() => text(page), before.slice(7), "Cut");
  await contextCommand("Paste");
  await eventually(() => text(page), before, "Paste");
  // The clipboard answers late, after other text was selected.
  await page.evaluate(() => {
    const read = navigator.clipboard.readText.bind(navigator.clipboard);
    navigator.clipboard.readText = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return read();
    };
  });
  await page.evaluate(() => window.runtimeTest.select(0));
  await contextCommand("Paste");
  await page.evaluate(() => window.runtimeTest.select(3, 9));
  await page
    .getByRole("alert")
    .filter({ hasText: "The selection changed before the text was pasted" })
    .waitFor();
  assert.equal(await text(page), before, "A late paste replaces nothing else");

  console.info("Checking the outline and search");
  await sidebar("Outline").click();
  const outline = page.getByRole("navigation", { name: "Document outline" });
  await outline.getByRole("button", { name: "Second" }).waitFor();
  await page.evaluate(() => {
    const at = window.runtimeTest.text().indexOf("\\section{Second}");
    window.runtimeTest.select(at);
  });
  // Not typed key by key, so that closing brackets are not completed.
  await page.keyboard.insertText("\\section{Inserted} ");
  await outline.getByRole("button", { name: "Inserted" }).waitFor();
  await sidebar("Search").click();
  await page.getByLabel("Search project files").fill("Inserted");
  await page.getByText("1 result in 1 file").waitFor();
  await page.evaluate(() => {
    const text = window.runtimeTest.text();
    window.runtimeTest.select(text.indexOf("\\end{document}"));
  });
  await page.keyboard.insertText("Inserted ");
  await page.getByText("2 results in 1 file").waitFor();

  console.info("Checking workers");
  assert.equal(await workers(page, "analysis.worker"), 1);
  for (const name of ["a.tex", "b.tex"])
    await page.evaluate(
      ({ name, parentId }) =>
        window.runtimeTest.create({ parentId, name, kind: "text" }),
      { name, parentId: rootId },
    );
  await page.waitForTimeout(500);
  assert.equal(
    await workers(page, "analysis.worker"),
    1,
    "Adding files keeps the analysis worker",
  );
  await sidebar("Files").click();
  for (const [name, formatted] of [
    ["main.tex", "\n  \\item Main"],
    ["chapter.tex", "\n  \\item Chapter"],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).dblclick();
    await page.getByRole("tab", { name: new RegExp(`^${name}`) }).waitFor();
    await content.waitFor();
    await menuCommand("Format document");
    await eventually(
      async () => (await text(page)).includes(formatted),
      true,
      `${name} is formatted`,
    );
  }
  assert.equal(await workers(page, "format.worker"), 1, "One format worker");

  console.info("Checking the layout and the PDF");
  await page.waitForTimeout(500);
  const saved = await layout(page);
  const handle = page.getByRole("separator", { name: "Resize right sidebar" });
  const box = await handle.boundingBox();
  assert(box);
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  for (let step = 1; step <= 20; step++)
    await page.mouse.move(box.x - step * 4, box.y + 200);
  assert.equal(await layout(page), saved, "Nothing is written during a drag");
  await page.mouse.up();
  await eventually(
    async () => (await layout(page)) !== saved,
    true,
    "The layout is written after a drag",
  );
  assert.equal(pdfRequests, 1, "The shared PDF loads once");
  await page.getByRole("button", { name: "output.pdf", exact: true }).click();
  await page.locator(".react-pdf__Page__canvas").waitFor();
  assert.equal(pdfRequests, 1, "Its tab does not load it again");
  await sidebar("Search").click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.match(await layout(page), /"rightView":"search"/);
  assert.deepEqual(errors, []);
  console.info("Editor runtime passed");
} finally {
  await browser.close();
  await workspace.stop();
}

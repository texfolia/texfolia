import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";

import { chromium, type Page } from "playwright";

import { editContext } from "#/lib/ai/revert";
import type { StoredMessage } from "#/lib/ai/threads";
import { renameNodeSchema } from "#/lib/projects";

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
    printedPages: number[];
  }
}

// Runs the real workspace in a browser, against a fixture of its network: image
// and PDF previews, the main document, quick open, and the assistant's changes.
const opening = String.raw`\documentclass{article}
\begin{document}
`;
const main = `${opening}${Array.from({ length: 30 }, (_, index) => `Sentence ${index} of the document.`).join("\n")}
\\end{document}
`;
const thesis = String.raw`\documentclass{book}
\begin{document}
Thesis
\end{document}
`;
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32"/></svg>';
const { project, node } = fixtureProject("Editor features", [
  { name: "main.tex", text: main },
  { name: "thesis.tex", text: thesis },
  { name: "drawing.svg", text: svg },
  { name: "figure.png" },
  { name: "secret.pdf" },
]);
const mainId = node("main.tex").id;

/** An opaque PNG of one color. */
function png(width: number, height: number) {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const frame = Buffer.alloc(8);
    frame.writeUInt32BE(data.length, 0);
    frame.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

// The assistant's chat: an edit of two passages, then another of the second.
const firstEdits = [
  { oldText: "Sentence 4 of the document.", newText: "A better sentence 4." },
  { oldText: "Sentence 20 of the document.\n", newText: "" },
];
const afterFirst = firstEdits.reduce(
  (text, { oldText, newText }) => text.replace(oldText, newText),
  main,
);
const secondEdit = {
  oldText: "A better sentence 4.",
  newText: "The best sentence 4.",
};
const afterSecond = afterFirst.replace(secondEdit.oldText, secondEdit.newText);
const contextOf = (text: string, at: number, length: number) =>
  editContext(text, [{ from: at, to: at + length }])[0]!;
function editCall(
  id: string,
  text: string,
  edits: { oldText: string; newText: string }[],
  places: number[],
): StoredMessage["parts"] {
  return [
    {
      type: "tool-call",
      id,
      name: "edit_file",
      arguments: JSON.stringify({ path: "main.tex", version: null, edits }),
      state: "complete",
    },
    {
      type: "tool-result",
      toolCallId: id,
      content: JSON.stringify({
        path: "main.tex",
        nodeId: mainId,
        version: "v",
        saved: true,
        context: edits.map((edit, index) =>
          contextOf(text, places[index]!, edit.newText.length),
        ),
      }),
      state: "complete",
    },
  ];
}
const message = (
  id: string,
  role: "user" | "assistant",
  parts: StoredMessage["parts"],
): StoredMessage => ({ id, role, parts });
const messages = [
  message("u1", "user", [{ type: "text", content: "Improve sentence 4" }]),
  message(
    "a1",
    "assistant",
    editCall("first", afterFirst, firstEdits, [
      afterFirst.indexOf("A better sentence 4."),
      afterFirst.indexOf("Sentence 21 of"),
    ]),
  ),
  message("u2", "user", [{ type: "text", content: "Even better" }]),
  message(
    "a2",
    "assistant",
    editCall(
      "second",
      afterSecond,
      [secondEdit],
      [afterSecond.indexOf(secondEdit.newText)],
    ),
  ),
];
const thread = {
  id: crypto.randomUUID(),
  title: "Sentences",
  model: null,
  updatedAt: new Date().toISOString(),
};
const longPdf = (version: string) =>
  pdfFixture({
    pages: Array.from({ length: 8 }, (_, index) =>
      index % 2 ? `Page ${index + 1} theorem` : `Page ${index + 1} ${version}`,
    ),
    width: 400,
    height: 500,
  });
let pdf = longPdf("first");
let compiled: string | undefined;

const workspace = await startWorkspace({
  project,
  pdf: () => pdf,
  async handle(request, url) {
    if (url.pathname.startsWith("/api/sources/")) {
      const id = url.pathname.split("/").at(-1);
      return id === node("figure.png").id
        ? new Response(png(200, 100))
        : id === node("secret.pdf").id
          ? new Response(
              pdfFixture({ pages: ["Protected text"], password: "letmein" }),
            )
          : undefined;
    }
    if (url.pathname === "/fixture/main-file") {
      const { mainFile } = (await request.json()) as {
        mainFile: string | null;
      };
      project.mainFile = mainFile;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/rename") {
      const { nodeId, name } = renameNodeSchema.parse(await request.json());
      const renamed = project.nodes.find(({ id }) => id === nodeId);
      if (renamed) renamed.name = name;
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname.startsWith("/api/compile/") &&
      request.method === "POST" &&
      request.headers.get("Content-Type")?.startsWith("application/json")
    ) {
      const body = (await request.json()) as { mainFile?: string };
      compiled = body.mainFile ?? compiled;
      return Response.json({ error: "Not compiled here" }, { status: 503 });
    }
    if (url.pathname.startsWith("/api/ai/")) {
      if (url.searchParams.has("thread"))
        return Response.json({ thread, messages });
      if (url.searchParams.has("threads"))
        return Response.json({ threads: [thread], more: false });
      return Response.json({
        enabled: true,
        models: [{ id: "model", name: "Model", inputPrice: 0, outputPrice: 0 }],
        defaultModel: "model",
        monthlyCapDollars: 10,
        spentDollars: 0,
        reservedDollars: 0,
        needsReview: false,
        pendingRequests: 0,
      });
    }
    return undefined;
  },
});
const source = () =>
  workspace.documents.get(mainId)?.getText("source").toString();

const screenshots = process.env.SCREENSHOT_DIR;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  await page.addInitScript(() => {
    // Frames run this too, and print into the workspace's record.
    const top = window.top as Window;
    top.printedPages ??= [];
    window.print = () => {
      top.printedPages.push(document.querySelectorAll("img").length);
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  const shot = async (name: string, target: Page = page) => {
    if (screenshots)
      await target.screenshot({ path: `${screenshots}/${name}.png` });
  };
  await page.goto(workspace.url);
  const content = page.locator('.cm-content[contenteditable="true"]');
  await content.waitFor();
  const tab = (name: string) =>
    page.getByRole("tab", { name: new RegExp(`^${name}`) });
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  const menu = async (name: string) => {
    await page
      .locator('[data-slot="menubar-trigger"]')
      .filter({ hasText: new RegExp(`^${name}$`) })
      .click();
  };

  console.info("Checking quick open and the command palette");
  await page.evaluate(() => window.runtimeTest.select(0));
  await page.keyboard.press("Control+P");
  const file = page.getByRole("combobox", { name: "File" });
  await file.waitFor();
  const options = page.getByRole("option");
  assert.equal(await options.count(), 6, "Five files and the PDF");
  assert.match(
    (await options.last().textContent()) ?? "",
    /main\.tex/,
    "The current file is listed last",
  );
  await shot("quick-open");
  await file.fill("thss");
  assert.equal(await options.count(), 1);
  await page.keyboard.press("Enter");
  await tab("thesis.tex").waitFor();
  await page.locator(".cm-focused").filter({ hasText: "Thesis" }).waitFor();
  await page.keyboard.press("Control+P");
  await file.fill("main.tex:6");
  await page.keyboard.press("Enter");
  await page.getByLabel("Workspace status").getByText("Ln 6, Col 1").waitFor();
  // Mod+P inside it returns to files, and never prints.
  await page.keyboard.press("Control+Shift+P");
  const command = page.getByRole("combobox", { name: "Command" });
  await command.waitFor();
  await page.keyboard.press("Control+P");
  await file.waitFor();
  await page.keyboard.press("Control+Shift+P");
  await command.waitFor();
  await page.keyboard.type("show outl");
  await shot("command-palette");
  await page.keyboard.press("Enter");
  await page
    .getByRole("navigation", { name: "Document outline" })
    .or(page.getByRole("heading", { name: "Outline" }))
    .first()
    .waitFor();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("find in file");
  await page.keyboard.press("Enter");
  await page.locator(".cm-search input[name=search]").waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("name")),
    "search",
    "A command keeps the focus it moved",
  );
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.evaluate(() => window.printedPages), []);

  console.info("Checking menu shortcuts");
  await menu("Edit");
  const search = page.getByRole("menuitem", {
    name: "Search in project",
    exact: true,
  });
  assert.equal(
    await search.getAttribute("aria-keyshortcuts"),
    "Control+Shift+F",
  );
  assert.match((await search.textContent()) ?? "", /Ctrl\+Shift\+F$/);
  await page.waitForTimeout(300);
  await shot("menu-shortcuts");
  await page.keyboard.press("Escape");

  console.info("Checking the main document");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("show files");
  await page.keyboard.press("Enter");
  await row("thesis.tex").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set as main document" }).click();
  await eventually(() => project.mainFile, "thesis.tex", "The choice is saved");
  await page.getByTitle("thesis.tex (main document)").waitFor();
  await row("thesis.tex").click({ button: "right" });
  assert.equal(
    await page.getByRole("menuitem", { name: "Set as main document" }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Compile status" }).click();
  await eventually(() => compiled, "thesis.tex", "The choice is compiled");
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  const select = page.getByLabel("Main document", { exact: true });
  assert.equal(await select.inputValue(), "thesis.tex");
  await select.selectOption({ label: "Automatic (main.tex)" });
  await shot("project-settings");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await eventually(() => project.mainFile, null, "Settings reset it");
  await page.getByTitle("main.tex (main document)").waitFor();
  // A collaborator's choice arrives with the files.
  project.mainFile = "thesis.tex";
  await page.evaluate(() => window.runtimeTest.refresh());
  await page.getByTitle("thesis.tex (main document)").waitFor();

  console.info("Checking image previews");
  await row("figure.png").dblclick();
  const image = page.getByRole("region", { name: "Image preview" });
  await image.getByText("200 × 100").waitFor();
  const picture = image.getByRole("img", { name: "figure.png" });
  assert.equal((await picture.boundingBox())?.width, 200, "Shown at its size");
  await image.getByRole("button", { name: /^Zoom/ }).click();
  await page.getByRole("menuitemradio", { name: "200%" }).click();
  await eventually(
    async () => (await picture.boundingBox())?.width,
    400,
    "A preset zooms",
  );
  await picture.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await eventually(
    async () => ((await picture.boundingBox())?.width ?? 0) > 400,
    true,
    "The wheel zooms",
  );
  await shot("image-preview");
  await image.getByRole("button", { name: "Fit to window" }).click();
  await eventually(
    async () => (await picture.boundingBox())?.width,
    200,
    "Fit returns",
  );
  await row("drawing.svg").dblclick();
  await page.getByRole("button", { name: /^Open image preview/ }).click();
  await page.getByText("64 × 32").waitFor();
  await tab("Preview: drawing.svg").getByRole("button").click();

  console.info("Checking the PDF viewer");
  await page.keyboard.press("Control+P");
  await file.fill("output.pdf");
  await page.keyboard.press("Enter");
  const viewer = page.getByRole("region", { name: "PDF preview" });
  const pages = viewer.getByRole("group", { name: "PDF pages" });
  const number = viewer.getByRole("spinbutton", { name: "Page number" });
  const zoom = viewer.getByRole("button", { name: /^Zoom/ });
  const pageText = (text: string) =>
    viewer.locator(".textLayer").getByText(text, { exact: true });
  await pageText("Page 1 first").waitFor();
  await viewer.getByText("/ 8").waitFor();
  await zoom.click();
  await page.getByRole("menuitemradio", { name: "75%" }).click();
  await zoom.getByText("75%").waitFor();
  await pageText("Page 2 theorem").waitFor();
  assert(
    (await viewer.locator("[data-page]").count()) < 8,
    "Only the pages near the viewport are drawn",
  );
  await pages.hover();
  await page.mouse.wheel(0, 1000);
  await eventually(() => number.inputValue(), "4", "Scrolling changes pages");
  await number.fill("8");
  await number.press("Enter");
  assert.equal(await number.inputValue(), "8");
  await pageText("Page 8 theorem").waitFor();
  await viewer.getByRole("button", { name: "Previous page" }).click();
  await eventually(() => number.inputValue(), "7", "Previous page");
  const scrollTop = () => pages.evaluate((element) => element.scrollTop);

  // A new build keeps the place, the zoom, and the rotation.
  await viewer.getByRole("button", { name: "More PDF actions" }).click();
  await page.getByRole("menuitem", { name: "Rotate clockwise" }).click();
  await number.fill("5");
  await number.press("Enter");
  await pages.hover();
  await page.mouse.wheel(0, 30);
  await page.waitForTimeout(400);
  const place = await scrollTop();
  assert(place > 0);
  pdf = longPdf("second");
  workspace.publishBuild();
  await pageText("Page 5 second").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await scrollTop(), place, "A build keeps the scroll position");
  assert.equal(await number.inputValue(), "5");
  await zoom.getByText("75%").waitFor();
  const box = await viewer.locator('[data-page="5"]').boundingBox();
  assert(box && box.width > box.height, "A build keeps the rotation");
  assert.equal(
    await viewer.locator(".react-pdf__Document").count(),
    1,
    "The last version is gone",
  );
  // Another tab hides the viewer, which keeps its place too.
  await tab("main.tex").click();
  await content.waitFor();
  await tab("output.pdf").click();
  await pageText("Page 5 second").waitFor();
  await eventually(scrollTop, place, "A hidden tab keeps its place");

  // The wheel zooms around the pointer.
  const target = viewer.locator('[data-page="5"]');
  const before = await target.boundingBox();
  assert(before);
  const pointer = { x: before.x + before.width / 4, y: before.y + 150 };
  // A page narrower than the viewport stays centered, so only its height counts.
  const fraction = (box: { y: number; height: number }) =>
    (pointer.y - box.y) / box.height;
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -90);
  await page.keyboard.up("Control");
  await eventually(
    async () => ((await target.boundingBox())?.width ?? 0) > before.width * 1.2,
    true,
    "The wheel zooms",
  );
  const after = await target.boundingBox();
  assert(after);
  assert(
    Math.abs(fraction(before) - fraction(after)) < 0.02,
    "The point under the pointer stays there",
  );
  await viewer.getByRole("button", { name: "Fit to width" }).click();

  console.info("Checking search in the PDF");
  await pages.focus();
  await page.keyboard.press("Control+F");
  const find = viewer.getByRole("textbox", { name: "Find in PDF" });
  await find.fill("THEOREM");
  await viewer.getByText("1 of 4").waitFor();
  await viewer.locator('mark[data-current="true"]').waitFor();
  assert.equal(await viewer.locator("mark").first().textContent(), "theorem");
  await find.press("Shift+Enter");
  await viewer.getByText("4 of 4").waitFor();
  await pageText("Page 8 theorem")
    .or(viewer.locator('[data-page="8"] mark'))
    .first()
    .waitFor();
  await shot("pdf-search");
  await find.fill("nowhere to be found");
  await viewer.getByText("No results").waitFor();
  await find.press("Escape");
  assert.equal(await find.count(), 0);

  console.info("Checking printing");
  await viewer.getByRole("button", { name: "More PDF actions" }).click();
  await page.getByRole("menuitem", { name: "Print…" }).click();
  await eventually(
    () => page.evaluate(() => window.printedPages),
    [8],
    "Every page prints",
  );
  await eventually(
    () => page.locator('iframe[title="Print preview"]').count(),
    0,
    "The print frame is removed",
  );

  console.info("Checking protected PDFs");
  await row("secret.pdf").dblclick();
  const password = page.getByRole("dialog", { name: "Password required" });
  await password.getByLabel("PDF password").fill("wrong");
  await password.getByRole("button", { name: "Open PDF" }).click();
  await password.getByText("That password is incorrect").waitFor();
  await shot("pdf-password");
  await password.getByRole("button", { name: "Cancel" }).click();
  await page.getByText("A password is required to show this PDF.").waitFor();
  await page.getByRole("button", { name: "Enter password" }).click();
  await password.getByLabel("PDF password").fill("letmein");
  await password.getByLabel("PDF password").press("Enter");
  await pageText("Protected text").waitFor();

  console.info("Checking the assistant's changes");
  await tab("main.tex").click();
  await content.waitFor();
  // The edits arrive as the assistant saved them.
  await page.evaluate((text) => window.runtimeTest.replace(text), afterSecond);
  await eventually(source, afterSecond, "The document holds the edits");
  const assistant = page.getByRole("complementary", { name: "AI assistant" });
  const cards = assistant.getByRole("button", { name: /^Edited main\.tex/ });
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  // The latest reply shows its diff.
  await assistant
    .getByRole("group", { name: "Edit 1 of main.tex" })
    .getByText("best", { exact: false })
    .first()
    .waitFor();
  await cards.first().click();
  await shot("assistant-diff");
  // The first edit was changed by the second, so it does not revert yet.
  const separately = assistant.getByRole("button", {
    name: "Revert this edit",
  });
  await separately.first().click();
  await assistant.getByText("The text has changed since.").waitFor();
  assert.equal(source(), afterSecond);
  await assistant.getByRole("button", { name: "Revert edit" }).click();
  await assistant.getByText("Reverted.", { exact: true }).waitFor();
  await eventually(source, afterFirst, "One edit reverts");
  await assistant.getByRole("button", { name: "Revert edit" }).click();
  await assistant.getByText("Already reverted.").waitFor();

  // Rolling back keeps a collaborator's edits, and says what it left.
  await page.evaluate(
    (text) => window.runtimeTest.replace(text),
    `% A note\n${afterFirst.replace("A better sentence 4.", "Somebody's sentence.")}`,
  );
  await page.evaluate(() => window.runtimeTest.select(0));
  await assistant
    .getByRole("button", { name: "Undo changes from here" })
    .first()
    .click();
  await assistant.getByText("Undid 1 change.").waitFor();
  await assistant
    .getByRole("list", { name: "Changes that were kept" })
    .getByText("1 of 2 edits")
    .waitFor();
  await shot("assistant-rollback");
  const rolledBack = `% A note\n${main.replace("Sentence 4 of the document.", "Somebody's sentence.")}`;
  await eventually(source, rolledBack, "Only the matching edit is undone");
  // It is an edit of the document, so Undo takes it back.
  await page.evaluate(() => window.runtimeTest.select(0));
  await page.keyboard.press("Control+Z");
  await eventually(
    () => source()?.includes("Sentence 20 of the document."),
    false,
    "Undo takes a rollback back",
  );

  console.info("Checking requests from the editor");
  const prompt = assistant.getByRole("textbox", {
    name: "Message the assistant",
  });
  await page.evaluate(() => {
    const text = window.runtimeTest.text();
    const at = text.indexOf("Sentence 7");
    window.runtimeTest.select(at, at + "Sentence 7".length);
  });
  await content.dispatchEvent("contextmenu", {
    button: 2,
    clientX: 700,
    clientY: 300,
  });
  await page.getByRole("menuitem", { name: "Ask AI about selection" }).focus();
  await page.keyboard.press("Enter");
  await eventually(
    async () =>
      /^About @main\.tex, line \d+:\n\n```\nSentence 7\n```\n\n$/.test(
        await prompt.inputValue(),
      ),
    true,
    "The selection is quoted",
  );
  await eventually(
    () => prompt.evaluate((element) => element === document.activeElement),
    true,
    "The message has focus",
  );
  await page.keyboard.type("Compare with @thes");
  await page.getByRole("option", { name: "thesis.tex" }).waitFor();
  await shot("assistant-mention");
  await page.keyboard.press("Enter");
  assert.match(await prompt.inputValue(), /Compare with @thesis\.tex $/);
  await prompt.fill("");
  await page.evaluate(() => {
    const text = window.runtimeTest.text();
    window.runtimeTest.select(text.indexOf("Sentence 9"));
  });
  await page.keyboard.insertText("\\ref{missing-label} ");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("show problems");
  await page.keyboard.press("Enter");
  const fix = page.getByRole("button", {
    name: /^Fix with AI: .*missing-label/,
  });
  await fix.first().click();
  await eventually(
    async () =>
      /^Fix this problem in @main\.tex, line \d+: .*missing-label/.test(
        await prompt.inputValue(),
      ),
    true,
    "The problem is named",
  );
  assert.deepEqual(errors, []);
  console.info("Editor features passed");
} finally {
  await browser.close();
  await workspace.stop();
}

import assert from "node:assert/strict";

import { chromium, type Locator, type Page } from "playwright";

import type { CommentThread } from "#/hooks/use-comments";
import { createCommentAnchor } from "#/lib/comments/anchor";

import {
  eventually,
  fixtureProject,
  startWorkspace,
} from "./editor-runtime/harness";
import { pdfFixture } from "./pdf-fixture";

// Runs the real workspace in a browser, against a fixture of its network:
// keyboard access, focus, names, resize handles, reduced motion and colors.
const main = Array.from({ length: 12 }, (_, line) => `Line ${line}.`).join(
  "\n",
);
const { project, node } = fixtureProject("Accessibility", [
  { name: "main.tex", text: main },
]);
const mainId = node("main.tex").id;

let threads: CommentThread[] = [];
function thread(id: string, quote: string): CommentThread {
  const text = workspace.documents.get(mainId)?.getText("source");
  assert(text);
  const from = main.indexOf(quote);
  return {
    id,
    nodeId: mainId,
    ...createCommentAnchor(text, from, from + quote.length),
    quote,
    createdBy: "runtime-test",
    createdAt: new Date(),
    resolvedAt: null,
    resolvedByName: null,
    comments: [
      {
        id: `${id}-1`,
        threadId: id,
        authorId: "runtime-test",
        authorName: "Runtime test",
        authorImage: null,
        body: `About ${quote}`,
        createdAt: new Date(),
        editedAt: null,
      },
    ],
  };
}

const workspace = await startWorkspace({
  project,
  pdf: () => pdfFixture({ pages: ["Page"], width: 400, height: 500 }),
  async handle(request, url) {
    if (url.pathname === "/fixture/comments")
      return Response.json({
        threads,
        canModerate: true,
        userId: "runtime-test",
      });
    if (url.pathname === "/fixture/comments/delete-thread") {
      const { threadId } = (await request.json()) as { threadId: string };
      threads = threads.filter(({ id }) => id !== threadId);
      return new Response(null, { status: 204 });
    }
    return undefined;
  },
});
threads = [thread("first", "Line 2."), thread("second", "Line 5.")];

const browser = await chromium.launch({ headless: true });
const screenshots = process.env.SCREENSHOT_DIR;
const errors: string[] = [];
async function open(options: Parameters<typeof browser.newPage>[0] = {}) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ...options,
  });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  page.on("dialog", (dialog) => {
    errors.push(`Native dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await page.goto(workspace.url);
  await page.locator(".cm-content").first().waitFor();
  return page;
}
const shot = async (page: Page, name: string) => {
  if (screenshots)
    await page.screenshot({ path: `${screenshots}/${name}.png` });
};
const style = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );
const value = async (handle: Locator) =>
  Number(await handle.getAttribute("aria-valuenow"));

try {
  const page = await open();

  console.info("Checking the comment gutter");
  const markers = page.getByRole("button", { name: "Show comment" });
  await eventually(
    () => markers.count(),
    2,
    "Markers are exposed to assistive technology",
  );
  assert.equal(
    await page.locator(".cm-lineNumbers").getAttribute("aria-hidden"),
    "true",
    "Line numbers stay hidden",
  );
  const focused = (id: string) =>
    eventually(
      () => page.evaluate(() => document.activeElement?.id),
      `comment-thread-${id}`,
      "The thread is focused",
    );
  await markers.first().focus();
  await page.keyboard.press("Enter");
  await focused("first");
  await markers.nth(1).focus();
  await page.keyboard.press("Space");
  await focused("second");
  await markers.first().click();
  await focused("first");
  assert.equal(
    await style(page.locator(".cm-comment-marker-active"), "color"),
    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--primary)";
      document.body.appendChild(probe);
      const { color } = getComputedStyle(probe);
      probe.remove();
      return color;
    }),
    "The active marker uses the theme",
  );
  await shot(page, "comments");

  console.info("Checking confirmations");
  const card = page.getByRole("article").first();
  await card.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete thread?" });
  await confirm.waitFor();
  await page.waitForTimeout(250);
  await shot(page, "confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await confirm.waitFor({ state: "detached" });
  assert.equal(threads.length, 2, "Canceling keeps the thread");
  await card.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await confirm.getByRole("button", { name: "Delete thread" }).click();
  await eventually(
    () => threads.map(({ id }) => id),
    ["second"],
    "Confirming deletes it",
  );
  await eventually(() => markers.count(), 1, "Its marker goes");

  console.info("Checking names and focus");
  const compile = page.getByRole("button", { name: /^Compile status:/ });
  assert.equal(
    await compile.getAttribute("aria-label"),
    `Compile status: ${await compile.innerText()}`,
    "The name includes the visible status",
  );
  const menu = page.locator('[data-slot="menubar-trigger"]').first();
  await page.keyboard.press("Tab");
  await menu.focus();
  assert.notEqual(
    await style(menu, "box-shadow"),
    "none",
    "Menus show keyboard focus",
  );
  await page
    .getByRole("toolbar", { name: "Right sidebar views" })
    .getByRole("button", { name: "Collaboration", exact: true })
    .click();
  assert.equal(
    await page.getByRole("heading", { name: "Collaboration" }).count(),
    1,
    "Collaboration has one heading",
  );

  console.info("Checking the resize handles");
  const sidebar = page.getByRole("separator", { name: "Resize right sidebar" });
  assert.equal(
    (await sidebar.boundingBox())?.width,
    1,
    "The handle shows as a hairline",
  );
  await sidebar.focus();
  await page.keyboard.press("Home");
  assert.equal(await value(sidebar), 240);
  await page.keyboard.press("End");
  assert.equal(await value(sidebar), 600);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await value(sidebar), 256);
  const drag = async (handle: Locator, button: "left" | "right") => {
    const box = await handle.boundingBox();
    assert(box);
    const at = { x: box.x + box.width / 2, y: box.y + 100 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button });
    await page.mouse.move(at.x - 40, at.y, { steps: 4 });
  };
  await drag(sidebar, "right");
  assert.equal(await value(sidebar), 256, "Other buttons do not drag");
  await page.mouse.up({ button: "right" });
  await page.keyboard.press("Escape");
  await drag(sidebar, "left");
  assert.equal(await value(sidebar), 296);
  // A second pointer neither moves the handle nor ends the drag.
  await sidebar.dispatchEvent("pointerdown", {
    pointerId: 99,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 0,
  });
  await sidebar.dispatchEvent("pointermove", { pointerId: 99, clientX: 10 });
  await sidebar.dispatchEvent("pointerup", { pointerId: 99, clientX: 10 });
  assert.equal(await value(sidebar), 296, "Another pointer is ignored");
  await sidebar.dispatchEvent("pointercancel", {
    pointerId: 1, // The mouse.
  });
  assert.equal(await value(sidebar), 256, "A canceled drag is undone");
  await page.mouse.move(400, 400);
  assert.equal(await value(sidebar), 256, "It no longer follows the pointer");
  await page.mouse.up();

  console.info("Checking touch targets");
  const touch = await open({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
  });
  await touch.evaluate(() => {
    const close = document.querySelector<HTMLElement>(
      '[aria-label="Close project sidebar"]',
    );
    close?.click();
  });
  await touch.getByRole("button", { name: "Compile logs" }).tap();
  const panel = touch.getByRole("separator", { name: "Resize panel" });
  await panel.waitFor();
  const target = await panel.evaluate((element) => {
    const { top, left, width } = element.getBoundingClientRect();
    const hits = (y: number) =>
      document.elementFromPoint(left + width / 2, y) === element;
    let size = 0;
    for (let y = top - 30; y < top + 30; y++) if (hits(y)) size++;
    return size;
  });
  assert(target >= 24, `The handle's touch target is ${target}px`);
  await shot(touch, "touch");
  await touch.close();

  console.info("Checking reduced motion");
  const transition = (of: Page) =>
    style(
      of.getByRole("button", { name: "Compile logs" }),
      "transition-property",
    );
  assert.match(await transition(page), /scale/);
  assert.doesNotMatch(await transition(page), /\ball\b/);
  const still = await open({ reducedMotion: "reduce" });
  assert.doesNotMatch(
    await transition(still),
    /scale|transform|translate|width|height|\ball\b/,
  );
  assert.match(await transition(still), /background-color/);
  await still.keyboard.press("Control+,");
  const settings = still.getByRole("dialog");
  await settings.waitFor();
  assert.deepEqual(
    await settings.evaluate((element) => [
      getComputedStyle(element).getPropertyValue("--tw-enter-scale").trim(),
      getComputedStyle(element).animationName,
    ]),
    ["1", "enter"],
    "Dialogs fade without growing",
  );
  const overlay = still.locator('[data-slot="dialog-overlay"]');
  assert.equal(
    await style(overlay, "background-color"),
    "rgba(0, 0, 0, 0.1)",
    "The backdrop is the theme's",
  );
  await settings.getByRole("button", { name: "Editor", exact: true }).click();

  console.info("Checking the font size field");
  const size = settings.getByRole("spinbutton", { name: "Editor font size" });
  const initial = await size.inputValue();
  await size.fill("99");
  assert.equal(await size.inputValue(), "99", "It can be typed");
  await size.blur();
  assert.equal(await size.inputValue(), initial, "It is not kept");
  await size.fill("18");
  await size.blur();
  assert.equal(await size.inputValue(), "18");
  await settings.getByRole("button", { name: "Cancel" }).click();
  await settings.waitFor({ state: "detached" });
  await still.keyboard.press("Control+,");
  await still
    .getByRole("dialog")
    .getByRole("button", { name: "Editor", exact: true })
    .click();
  assert.equal(
    await size.inputValue(),
    initial,
    "Canceling restores what was saved",
  );

  console.info("Checking blocked session storage");
  const blocked = await browser.newPage();
  blocked.on("pageerror", (error) => errors.push(error.message));
  await blocked.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await blocked.goto(workspace.url);
  await blocked
    .getByRole("toolbar", { name: "Right sidebar views" })
    .getByRole("button", { name: "Git", exact: true })
    .click();
  await blocked.locator('[data-testid="git-panel"]').waitFor();

  assert.deepEqual(errors, []);
  console.info("Workspace accessibility passed");
} finally {
  await browser.close();
  await workspace.stop();
}

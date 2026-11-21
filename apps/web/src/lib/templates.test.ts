import { expect, test } from "bun:test";

import {
  fetchTemplateCatalog,
  parseTemplatePage,
  templatePageSize,
  type PublicTemplate,
} from "./templates";

test("page numbers are clamped to the catalog API range", () => {
  expect(parseTemplatePage(undefined)).toBe(0);
  expect(parseTemplatePage("3")).toBe(3);
  expect(parseTemplatePage(2.7)).toBe(2);
  expect(parseTemplatePage(-4)).toBe(0);
  expect(parseTemplatePage(5000)).toBe(1000);
  expect(parseTemplatePage("nope")).toBe(0);
});

const template: PublicTemplate = {
  id: "t1",
  title: "Thesis",
  description: "A thesis",
  tags: ["thesis"],
  license: "MIT",
  publisherName: "Ada",
  previewStatus: "ready",
};

test("the catalog is read from the app origin", async () => {
  let requested = "";
  const page = await fetchTemplateCatalog("https://app.example", 2, (async (
    input: URL,
    _init?: RequestInit,
  ) => {
    requested = input.href;
    return Response.json([template]);
  }) as typeof fetch);
  expect(requested).toBe("https://app.example/api/templates?page=2");
  expect(page).toEqual({ ok: true, templates: [template], hasNext: false });
});

test("a full page offers a next page", async () => {
  const page = await fetchTemplateCatalog("https://app.example", 0, (async () =>
    Response.json(
      Array(templatePageSize).fill(template),
    )) as unknown as typeof fetch);
  expect(page.ok && page.hasNext).toBe(true);
});

test("app errors and network failures become an unavailable gallery", async () => {
  expect(
    await fetchTemplateCatalog(
      "https://app.example",
      0,
      (async () =>
        new Response("", { status: 503 })) as unknown as typeof fetch,
    ),
  ).toEqual({ ok: false });
  expect(
    await fetchTemplateCatalog("https://app.example", 0, (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch),
  ).toEqual({ ok: false });
});

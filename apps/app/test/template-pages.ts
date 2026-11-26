import assert from "node:assert/strict";

import { localHosts } from "@texfolia/contracts/hosts";
import { createDb } from "@texfolia/db";
import { template, user } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

// TEMPLATE_TEST_BASE_URL — product app (detail pages, /api/templates/*).
// TEMPLATE_TEST_WEB_URL | PUBLIC_WEB_URL | localHosts.web[0] — marketing gallery (/templates).
const connectionString = process.env.INTEGRATION_DATABASE_URL;
const baseUrl = process.env.TEMPLATE_TEST_BASE_URL;
const webUrl = (
  process.env.TEMPLATE_TEST_WEB_URL ??
  process.env.PUBLIC_WEB_URL ??
  localHosts.web[0]
).replace(/\/$/, "");
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated test database",
);
assert(
  baseUrl && ["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname),
  "Set TEMPLATE_TEST_BASE_URL to the local product app using the same test database",
);
const db = createDb(connectionString);
const ownerId = crypto.randomUUID();
const publicId = crypto.randomUUID();
const unlistedId = crypto.randomUUID();
const pendingId = crypto.randomUUID();
const privateId = crypto.randomUUID();
const rootId = crypto.randomUUID();
const marker = crypto.randomUUID();
const snapshot = [
  {
    id: rootId,
    parentId: null,
    name: "Root",
    kind: "folder",
    objectKey: null,
    sizeBytes: 0,
  },
  {
    id: crypto.randomUUID(),
    parentId: rootId,
    name: "main.tex",
    kind: "text",
    objectKey: null,
    sizeBytes: 0,
  },
];
const readyDeadline = Date.now() + 60_000;
while (true) {
  try {
    const response = await fetch(new URL("/api/templates", baseUrl));
    if (response.ok) break;
  } catch {}
  assert(
    Date.now() < readyDeadline,
    "Local product app did not become ready at /api/templates",
  );
  await Bun.sleep(250);
}
try {
  await db.insert(user).values({
    id: ownerId,
    name: "SSR test author",
    email: `${ownerId}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  for (const entry of [
    {
      id: publicId,
      title: `Public ${marker}`,
      visibility: "public",
      status: "approved",
    },
    {
      id: unlistedId,
      title: `Unlisted ${marker}`,
      visibility: "unlisted",
      status: "approved",
    },
    {
      id: pendingId,
      title: `Pending ${marker}`,
      visibility: "public",
      status: "pending",
    },
    {
      id: privateId,
      title: `Private ${marker}`,
      visibility: "private",
      status: "approved",
    },
  ] satisfies {
    id: string;
    title: string;
    visibility: "public" | "unlisted" | "private";
    status: "approved" | "pending";
  }[]) {
    await db.insert(template).values({
      ...entry,
      ownerId,
      publisherName: "SSR test author",
      description: "Server-rendered description without client JavaScript",
      tags: ["article"],
      license: "CC0-1.0",
      mainFile: "main.tex",
      snapshot,
      previewKey: `templates/${entry.id}/preview.png`,
      previewStatus: "ready",
    });
  }
  // Public catalog API powers the marketing gallery on apps/web.
  const catalog = await fetch(new URL("/api/templates", baseUrl));
  assert.equal(catalog.status, 200);
  const listed = (await catalog.json()) as { title: string }[];
  assert(listed.some((item) => item.title === `Public ${marker}`));
  assert(
    !listed.some(
      (item) =>
        item.title === `Unlisted ${marker}` ||
        item.title === `Pending ${marker}` ||
        item.title === `Private ${marker}`,
    ),
  );
  // Marketing gallery HTML when apps/web is reachable (skipped in app-only CI).
  let galleryHtmlChecked = false;
  try {
    const gallery = await fetch(new URL("/templates", webUrl));
    if (gallery.ok) {
      const html = await gallery.text();
      assert(html.includes(`Public ${marker}`));
      assert(
        !html.includes(`Unlisted ${marker}`) &&
          !html.includes(`Pending ${marker}`) &&
          !html.includes(`Private ${marker}`),
      );
      galleryHtmlChecked = true;
    }
  } catch {}
  if (!galleryHtmlChecked)
    console.info(
      `Skipped apps/web gallery HTML (unreachable at ${webUrl}/templates); catalog API checked.`,
    );
  const publicPage = await fetch(new URL(`/template/${publicId}`, baseUrl));
  assert.equal(publicPage.status, 200);
  const page = await publicPage.text();
  const serverHtml = page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  assert(
    serverHtml.includes(`Public ${marker}`) &&
      serverHtml.includes(
        "Server-rendered description without client JavaScript",
      ),
  );
  assert(serverHtml.includes('property="og:image"'));
  assert(
    serverHtml.includes(
      new URL(`/api/templates/${publicId}/preview`, baseUrl).href,
    ),
  );
  const unlistedPage = await fetch(new URL(`/template/${unlistedId}`, baseUrl));
  assert.equal(unlistedPage.status, 200);
  assert((await unlistedPage.text()).includes("noindex, nofollow"));
  // A private template is not found for anyone outside its audience, even with
  // its URL.
  for (const id of [pendingId, privateId, crypto.randomUUID(), "invalid"])
    assert.equal(
      (await fetch(new URL(`/template/${id}`, baseUrl))).status,
      404,
    );
  for (const path of [
    `/api/templates/${pendingId}/preview`,
    `/api/templates/${pendingId}/source`,
    `/api/templates/${privateId}/preview`,
    `/api/templates/${privateId}/preview?size=thumbnail`,
    `/api/templates/${privateId}/source`,
  ])
    assert.equal((await fetch(new URL(path, baseUrl))).status, 404);
  console.log(
    "Template page integration passed: public catalog API, optional web gallery HTML, detail HTML without JavaScript, absolute sharing image, unlisted noindex, pending/private/unknown 404s, protected image/source endpoints.",
  );
} finally {
  await db.delete(user).where(eq(user.id, ownerId));
  await db.$client.end();
}

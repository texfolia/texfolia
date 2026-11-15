import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import { template, user } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
const baseUrl = process.env.TEMPLATE_TEST_BASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated test database",
);
assert(
  baseUrl && ["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname),
  "Set TEMPLATE_TEST_BASE_URL to the local web app using the same test database",
);
const db = createDb(connectionString);
const ownerId = crypto.randomUUID();
const publicId = crypto.randomUUID();
const unlistedId = crypto.randomUUID();
const pendingId = crypto.randomUUID();
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
    const response = await fetch(new URL("/templates", baseUrl));
    if (response.ok) break;
  } catch {}
  assert(
    Date.now() < readyDeadline,
    "Local templates server did not become ready",
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
  ] satisfies {
    id: string;
    title: string;
    visibility: "public" | "unlisted";
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
  const gallery = await fetch(new URL("/templates", baseUrl));
  assert.equal(gallery.status, 200);
  const html = await gallery.text();
  assert(html.includes(`Public ${marker}`));
  assert(
    !html.includes(`Unlisted ${marker}`) && !html.includes(`Pending ${marker}`),
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
  for (const id of [pendingId, crypto.randomUUID(), "invalid"])
    assert.equal(
      (await fetch(new URL(`/template/${id}`, baseUrl))).status,
      404,
    );
  for (const path of [
    `/api/templates/${pendingId}/preview`,
    `/api/templates/${pendingId}/source`,
  ])
    assert.equal((await fetch(new URL(path, baseUrl))).status, 404);
  console.log(
    "Template page integration passed: public gallery and detail HTML without JavaScript, absolute sharing image, unlisted noindex, pending/unknown 404s, protected image/source endpoints.",
  );
} finally {
  await db.delete(user).where(eq(user.id, ownerId));
  await db.$client.end();
}

import { expect, mock, test } from "bun:test";

import { templatePreview } from "./preview-response.server";
import { thumbnailKey } from "./thumbnail.server";

const previewKey = "templates/t/previews/j.png";

function harness({ broken = false } = {}) {
  const stored = new Map([[previewKey, "png"]]);
  const bucket = {
    get: mock(async (key: string) => {
      const value = stored.get(key);
      return value === undefined ? null : { body: new Response(value).body! };
    }),
    put: mock(async (key: string, value: ArrayBuffer) => {
      stored.set(key, new TextDecoder().decode(value));
    }),
  };
  const transform = mock(() => ({
    output: async () => {
      if (broken) throw new Error("Images is unavailable");
      return { response: () => new Response("webp") };
    },
  }));
  const request = (
    search = "",
    {
      etag,
      status = "approved",
      visibility = "public",
    }: {
      etag?: string | null;
      status?: "approved" | "pending" | "rejected";
      visibility?: "public" | "unlisted";
    } = {},
  ) =>
    templatePreview({
      request: new Request(
        `https://app.test/api/templates/t/preview${search}`,
        {
          headers: etag ? { "If-None-Match": etag } : {},
        },
      ),
      bucket: bucket as never,
      images: { input: () => ({ transform }) } as never,
      found: { previewKey, status, visibility },
    });
  return { request, bucket, stored, transform };
}

test("public previews are cached by anyone and revalidated without storage", async () => {
  const { request, bucket } = harness();
  const response = await request();
  expect(await response.text()).toBe("png");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  expect(response.headers.get("X-Robots-Tag")).toBe("all");
  bucket.get.mockClear();
  const again = await request("", { etag: response.headers.get("ETag") });
  expect(again.status).toBe(304);
  expect(again.headers.get("Cache-Control")).toBe("public, max-age=86400");
  expect(bucket.get).not.toHaveBeenCalled();
});

test("unlisted and unapproved previews and thumbnails stay private", async () => {
  for (const state of [
    { visibility: "unlisted" },
    { status: "pending" },
    { status: "rejected" },
    { status: "pending", visibility: "unlisted" },
  ] as const)
    for (const search of ["", "?size=thumbnail"]) {
      const { request } = harness();
      const response = await request(search, { ...state, etag: "*" });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.has("ETag")).toBe(false);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
});

test("a thumbnail is made once and then served from storage", async () => {
  const { request, stored, transform } = harness();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request("?size=thumbnail");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await response.text()).toBe("webp");
  }
  expect(transform).toHaveBeenCalledTimes(1);
  expect(stored.get(thumbnailKey(previewKey))).toBe("webp");
  const { headers } = await request("?size=thumbnail");
  const etag = headers.get("ETag");
  expect((await request("?size=thumbnail", { etag })).status).toBe(304);
  expect((await request("", { etag })).status).toBe(200);
});

test("a preview stands in for a thumbnail that cannot be made, briefly", async () => {
  const error = mock(() => {});
  const { error: original } = console;
  console.error = error;
  try {
    const { request, stored, transform } = harness({ broken: true });
    const response = await request("?size=thumbnail");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.text()).toBe("png");
    expect(stored.has(thumbnailKey(previewKey))).toBe(false);
    // Revalidating tries again.
    await request("?size=thumbnail", { etag: response.headers.get("ETag") });
    expect(transform).toHaveBeenCalledTimes(2);
  } finally {
    console.error = original;
  }
});

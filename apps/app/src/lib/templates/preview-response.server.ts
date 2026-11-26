import type { template } from "@texfolia/db/schema";

import { matchesEtag, weakEtag } from "#/lib/etag";
import type { SourceBucket } from "#/lib/storage/server";

import { templateThumbnail, thumbnailKey } from "./thumbnail.server";

/**
 * The stored preview, or its thumbnail for `?size=thumbnail`. Browsers and
 * shared caches keep only what is in the public gallery: an unlisted template
 * is for people with its link, a private one for its owner or organization,
 * and an unapproved one for its owner and reviewers.
 */
export async function templatePreview({
  request,
  bucket,
  images,
  found,
}: {
  request: Request;
  bucket: SourceBucket;
  images: Pick<ImagesBinding, "input">;
  found: Pick<
    typeof template.$inferSelect,
    "previewKey" | "status" | "visibility" | "unpublishedAt"
  >;
}) {
  const { previewKey } = found;
  if (!previewKey) return new Response("Not found", { status: 404 });
  const listed =
    found.status === "approved" &&
    found.visibility === "public" &&
    !found.unpublishedAt;
  const headers = (contentType: string, key: string, maxAge: number) => ({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    ...(listed
      ? {
          "Cache-Control": `public, max-age=${maxAge}`,
          ETag: weakEtag(key),
          "X-Robots-Tag": "all",
        }
      : {
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        }),
  });
  const day = 86_400;
  const notModified = (key: string) =>
    listed && matchesEtag(request, weakEtag(key));
  const thumbnail =
    new URL(request.url).searchParams.get("size") === "thumbnail";

  if (thumbnail) {
    const key = thumbnailKey(previewKey);
    const thumbnailHeaders = headers("image/webp", key, day);
    if (notModified(key))
      return new Response(null, { status: 304, headers: thumbnailHeaders });
    const body = await templateThumbnail({ bucket, images, previewKey });
    if (body) return new Response(body, { headers: thumbnailHeaders });
  }
  // A preview sent in place of a thumbnail is only kept until the next attempt.
  const previewHeaders = headers(
    "image/png",
    previewKey,
    thumbnail ? 300 : day,
  );
  if (!thumbnail && notModified(previewKey))
    return new Response(null, { status: 304, headers: previewHeaders });
  const object = await bucket.get(previewKey);
  return object
    ? new Response(object.body, { headers: previewHeaders })
    : new Response("Not found", { status: 404 });
}

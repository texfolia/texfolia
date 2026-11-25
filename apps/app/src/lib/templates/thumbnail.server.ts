import type { SourceBucket } from "#/lib/storage/server";

// Gallery cards are at most 384 CSS pixels wide.
const thumbnailWidth = 600;

/** Where a preview's gallery thumbnail is stored. */
export const thumbnailKey = (previewKey: string) =>
  `${previewKey.replace(/\.png$/, "")}.thumbnail.webp`;

/**
 * The gallery thumbnail of a stored preview, made the first time it is asked
 * for. Null when it cannot be made, and callers send the preview instead.
 */
export async function templateThumbnail({
  bucket,
  images,
  previewKey,
}: {
  bucket: SourceBucket;
  images: Pick<ImagesBinding, "input">;
  previewKey: string;
}): Promise<BodyInit | null> {
  const key = thumbnailKey(previewKey);
  const saved = await bucket.get(key);
  if (saved) return saved.body;
  const preview = await bucket.get(previewKey);
  if (!preview) return null;
  let bytes: ArrayBuffer;
  try {
    const result = await images
      .input(preview.body)
      .transform({ width: thumbnailWidth, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80 });
    bytes = await result.response().arrayBuffer();
  } catch (error) {
    console.error("Template thumbnail failed", { previewKey, error });
    return null;
  }
  // Collection deletes it if the template is deleted meanwhile.
  await bucket
    .put(key, bytes, { httpMetadata: { contentType: "image/webp" } })
    .catch((error: unknown) =>
      console.error("Template thumbnail was not saved", { previewKey, error }),
    );
  return bytes;
}

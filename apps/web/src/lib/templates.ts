/** One approved public template, as served by the app's `GET /api/templates`. */
export type PublicTemplate = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  license: string;
  publisherName: string;
  previewStatus: "ready" | "pending" | "failed" | (string & {});
};

/** The app returns at most this many templates per catalog page. */
export const templatePageSize = 24;

/** Clamp a `?page=` value to the range the app's catalog API accepts. */
export function parseTemplatePage(value: unknown) {
  const page = Number(value ?? 0);
  return Number.isFinite(page)
    ? Math.min(1000, Math.max(0, Math.trunc(page)))
    : 0;
}

// Show the unavailable notice instead of holding the page when the app is slow.
const catalogTimeoutMs = 5000;

export type TemplateCatalogPage =
  | { ok: true; templates: PublicTemplate[]; hasNext: boolean }
  | { ok: false };

/** Read one page of the public catalog from the product app. */
export async function fetchTemplateCatalog(
  appOrigin: string,
  page: number,
  fetcher: typeof fetch = fetch,
): Promise<TemplateCatalogPage> {
  try {
    const response = await fetcher(
      new URL(`/api/templates?page=${page}`, `${appOrigin}/`),
      { signal: AbortSignal.timeout(catalogTimeoutMs) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const templates = (await response.json()) as PublicTemplate[];
    return {
      ok: true,
      templates,
      hasNext: templates.length === templatePageSize,
    };
  } catch {
    return { ok: false };
  }
}

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

/** The licenses a template can have, as the app's catalog API names them. */
export const templateLicenses = {
  "CC0-1.0": "CC0 1.0",
  "CC-BY-4.0": "CC BY 4.0",
  MIT: "MIT",
  "LPPL-1.3c": "LPPL 1.3c",
};
export type TemplateLicense = keyof typeof templateLicenses;

/** A page of the gallery. The URL leaves out what is not set. */
export type TemplateSearch = {
  page?: number;
  q?: string;
  tag?: string;
  license?: TemplateLicense;
};

export const maxTemplateQuery = 100;
export const maxTemplateTag = 32;

function text(value: unknown, maxLength: number) {
  // The router reads a search value like `2024` as a number.
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return String(value).trim().slice(0, maxLength) || undefined;
}

export function parseTemplateSearch(
  search: Record<string, unknown>,
): TemplateSearch {
  const { license } = search;
  return {
    page: parseTemplatePage(search.page) || undefined,
    q: text(search.q, maxTemplateQuery),
    tag: text(search.tag, maxTemplateTag)?.toLowerCase(),
    license:
      typeof license === "string" && Object.hasOwn(templateLicenses, license)
        ? (license as TemplateLicense)
        : undefined,
  };
}

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
  search: TemplateSearch,
  fetcher: typeof fetch = fetch,
): Promise<TemplateCatalogPage> {
  try {
    const { page = 0, q, tag, license } = search;
    const url = new URL(`/api/templates?page=${page}`, `${appOrigin}/`);
    for (const [name, value] of Object.entries({ q, tag, license }))
      if (value) url.searchParams.set(name, value);
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(catalogTimeoutMs),
    });
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

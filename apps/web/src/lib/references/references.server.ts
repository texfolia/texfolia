import { parseReferenceId, type ReferenceId } from "@texfolia/editor";
import { z } from "zod";

// Looks up citation metadata and formats it as one BibTeX entry.
//
// - DOIs use content negotiation at doi.org, which answers for Crossref,
//   DataCite and the other registration agencies.
// - arXiv IDs use the DOIs arXiv registers with DataCite (10.48550/arXiv.<id>),
//   so they share that path and avoid arXiv's 1-request-per-3-seconds API.
// - ISBNs use Open Library's books API.
//
// Metadata is requested as CSL JSON rather than BibTeX so every source gets
// the same keys, escaping and field layout.

export const userAgent = "Texfolia/1.0 (+https://texfolia.com)";
const timeout = 8_000;
const maxBytes = 1024 * 1024;
const maxRedirects = 5;

export class ReferenceNotFoundError extends Error {}
export class ReferenceSourceError extends Error {}

const text = z.union([z.string(), z.number()]).transform(String);
const name = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
  // Crossref puts organization names here.
  name: z.string().optional(),
});
const date = z.object({
  "date-parts": z.array(z.array(z.union([z.number(), z.string()]))).optional(),
});
const titleText = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value[0] : value));
const csl = z.object({
  type: z.string().catch("article"),
  title: titleText.optional(),
  subtitle: titleText.optional(),
  author: z.array(name).optional(),
  editor: z.array(name).optional(),
  issued: date.optional(),
  "container-title": titleText.optional(),
  "collection-title": titleText.optional(),
  publisher: z.string().optional(),
  "publisher-place": z.string().optional(),
  // Crossref sends its own name for publisher-place.
  "publisher-location": z.string().optional(),
  volume: text.optional(),
  issue: text.optional(),
  page: text.optional(),
  edition: text.optional(),
  number: text.optional(),
  DOI: z.string().optional(),
  URL: z.string().optional(),
  ISBN: z.union([z.string(), z.array(z.string())]).optional(),
});
export type CslItem = z.infer<typeof csl>;

const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const stopWords = new Set(
  "a an and as at by for from in into of on or the to towards via with".split(
    " ",
  ),
);

function codePoint(code: number) {
  // Surrogates and out-of-range values are not characters.
  return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : undefined;
}

function decodeEntities(value: string) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
    (match, decimal: string, hex: string, named: string) => {
      if (decimal) return codePoint(Number(decimal)) ?? match;
      if (hex) return codePoint(parseInt(hex, 16)) ?? match;
      return (
        {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        }[named.toLowerCase()] ?? match
      );
    },
  );
}

/** Plain text from metadata that may carry JATS or MathML markup. */
function plain(value: string) {
  return decodeEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

const escapes: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

function escape(value: string) {
  return plain(value).replace(/[\\{}&%$#_~^]/g, (char) => escapes[char] ?? "");
}

/** Escapes a title and braces words like "DNA" so styles keep their case. */
function title(value: string) {
  return escape(value).replace(
    /(?<![\\\w])[\p{L}\d-]*\p{Lu}[\p{L}\d-]*\p{Lu}[\p{L}\d-]*/gu,
    "{$&}",
  );
}

function person(value: z.infer<typeof name>) {
  const literal = value.literal ?? value.name;
  if (!value.family) return literal ? `{${escape(literal)}}` : "";
  return value.given
    ? `${escape(value.family)}, ${escape(value.given)}`
    : escape(value.family);
}

function people(values: z.infer<typeof name>[] | undefined) {
  const names = (values ?? []).map(person).filter(Boolean);
  return names.length ? names.join(" and ") : undefined;
}

function ascii(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z\d]/gi, "")
    .toLowerCase();
}

/** The issued year, when it is one. Sources may send any text or number. */
function issuedYear(item: CslItem) {
  const year = String(item.issued?.["date-parts"]?.[0]?.[0] ?? "").trim();
  return /^-?\d{1,4}$/.test(year) ? year : undefined;
}

/** A Google Scholar style key: family name, year, first significant word. */
export function citationKey(item: CslItem) {
  const first = item.author?.[0] ?? item.editor?.[0];
  const family = ascii(
    plain(first?.family ?? first?.literal ?? first?.name ?? ""),
  ).slice(0, 20);
  const year = issuedYear(item) ?? "";
  const word =
    plain(item.title ?? "")
      .split(/[\s\-–—:]+/)
      .map(ascii)
      .find((part) => part && !stopWords.has(part)) ?? "";
  return `${family}${year}${word.slice(0, 20)}` || "reference";
}

// CSL types, plus the Crossref types its content negotiation also sends.
function entryType(item: CslItem, eprint: boolean) {
  if (eprint) return "misc";
  switch (item.type) {
    case "article-journal":
    case "article-magazine":
    case "article-newspaper":
    case "journal-article":
      return "article";
    case "paper-conference":
    case "proceedings-article":
      return "inproceedings";
    case "chapter":
    case "entry-encyclopedia":
    case "entry-dictionary":
    case "book-chapter":
    case "book-section":
    case "book-part":
    case "reference-entry":
      return "incollection";
    case "book":
    case "monograph":
    case "edited-book":
    case "reference-book":
      return "book";
    case "report":
      return "techreport";
    case "thesis":
    case "dissertation":
      return "phdthesis";
    default:
      return "misc";
  }
}

/** Formats CSL JSON as a BibTeX entry. */
export function cslToBibtex(
  item: CslItem,
  { arxiv, isbn }: { arxiv?: string; isbn?: string } = {},
) {
  const type = entryType(item, !!arxiv);
  const month = item.issued?.["date-parts"]?.[0]?.[1];
  const container = item["container-title"];
  const fullTitle =
    item.title && item.subtitle && !item.title.includes(item.subtitle)
      ? `${item.title}: ${item.subtitle}`
      : item.title;
  const publisher = item.publisher && escape(item.publisher);
  const number = item.issue ?? item.number;
  const place = item["publisher-place"] ?? item["publisher-location"];
  // Biblatex reads doi and url verbatim, so they are not escaped.
  const verbatim = (value: string | undefined) =>
    value?.replace(/[{}\s]/g, "") || undefined;
  const fields: Array<[string, string | undefined, boolean?]> = [
    ["author", people(item.author)],
    [
      "editor",
      type === "book" && item.author?.length ? undefined : people(item.editor),
    ],
    ["title", fullTitle && title(fullTitle)],
    [
      "journal",
      type === "article" ? container && escape(container) : undefined,
    ],
    [
      "booktitle",
      type === "inproceedings" || type === "incollection"
        ? container && title(container)
        : undefined,
    ],
    ["series", item["collection-title"] && escape(item["collection-title"])],
    ["edition", item.edition && escape(item.edition)],
    ["volume", item.volume && escape(item.volume)],
    ["number", number && escape(number)],
    ["pages", item.page && escape(item.page.replace(/\s*[-–—]+\s*/g, "--"))],
    ...(type === "techreport"
      ? [["institution", publisher] as [string, string | undefined]]
      : type === "phdthesis"
        ? [["school", publisher] as [string, string | undefined]]
        : arxiv
          ? []
          : [["publisher", publisher] as [string, string | undefined]]),
    ["address", place && escape(place)],
    ["year", issuedYear(item)],
    ["month", typeof month === "number" ? months[month - 1] : undefined, true],
    ["eprint", arxiv],
    ["archivePrefix", arxiv && "arXiv"],
    ["isbn", isbn],
    ["doi", verbatim(item.DOI)],
    ["url", item.DOI ? undefined : verbatim(item.URL)],
  ];
  const lines = fields.flatMap(([field, value, bare]) =>
    value ? [`  ${field} = ${bare ? value : `{${value}}`},`] : [],
  );
  return `@${type}{${citationKey(item)},\n${lines.join("\n")}\n}\n`;
}

type Fetch = typeof fetch;

/**
 * The next hop of a redirect, when it may be followed. DOI agencies run their
 * own hosts, so any public HTTPS name is allowed, but not IP addresses,
 * single-label or internal names, credentials, or other ports.
 */
function redirectTarget(location: string | null, base: string) {
  if (!location || !URL.canParse(location, base)) return null;
  const url = new URL(location, base);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^([a-z\d]([a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*[a-z\d]$/.test(host) &&
    !/\.(localhost|local|internal|intranet|lan|home|corp|test|invalid|home\.arpa)$/.test(
      host,
    )
    ? url.href
    : null;
}

async function send(fetcher: Fetch, url: string, accept: string) {
  const signal = AbortSignal.timeout(timeout);
  for (let next = url, hops = 0; ; hops++) {
    const response = await fetcher(next, {
      headers: { Accept: accept, "User-Agent": userAgent },
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const target = redirectTarget(response.headers.get("Location"), next);
    if (!target || hops >= maxRedirects)
      throw new ReferenceSourceError(
        "The metadata service sent a redirect that could not be followed.",
      );
    next = target;
  }
}

async function sendWithRetry(fetcher: Fetch, url: string, accept: string) {
  try {
    return await send(fetcher, url, accept);
  } catch (error) {
    // Open Library often resets connections; a timeout is not retried.
    if (
      error instanceof ReferenceSourceError ||
      (error instanceof DOMException && error.name === "TimeoutError")
    )
      throw error;
    return await send(fetcher, url, accept);
  }
}

/** Reads a body up to the size cap, however it is encoded or framed. */
async function readText(response: Response) {
  const tooLarge = new ReferenceSourceError(
    "The metadata service sent a record that is too large.",
  );
  if (Number(response.headers.get("Content-Length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return result + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw tooLarge;
    }
    result += decoder.decode(value, { stream: true });
  }
}

async function request(fetcher: Fetch, url: string, accept: string) {
  let body: string;
  try {
    const response = await sendWithRetry(fetcher, url, accept);
    if (!response.ok) await response.body?.cancel();
    if (response.status === 404 || response.status === 410)
      throw new ReferenceNotFoundError("No reference was found for this ID.");
    if (!response.ok)
      throw new ReferenceSourceError(
        `The metadata service answered ${response.status}.`,
      );
    body = await readText(response);
  } catch (error) {
    if (
      error instanceof ReferenceNotFoundError ||
      error instanceof ReferenceSourceError
    )
      throw error;
    throw new ReferenceSourceError("The metadata service did not respond.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Some agencies answer an unknown DOI with an HTML landing page.
    throw new ReferenceNotFoundError("No reference was found for this ID.");
  }
}

function doiUrl(doi: string) {
  return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
}

const openLibraryBook = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  authors: z.array(z.object({ name: z.string() })).optional(),
  publishers: z.array(z.object({ name: z.string() })).optional(),
  publish_places: z.array(z.object({ name: z.string() })).optional(),
  publish_date: z.string().optional(),
  url: z.string().optional(),
});

/** Open Library gives whole names; split off the last word as the family. */
function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  const family = parts.pop() ?? full;
  return parts.length ? { family, given: parts.join(" ") } : { family };
}

export type ReferenceResult = {
  key: string;
  bibtex: string;
  source: "doi" | "arxiv" | "isbn";
};

export async function lookupReference(
  id: ReferenceId,
  fetcher: Fetch = fetch,
): Promise<ReferenceResult> {
  if (id.kind === "isbn") {
    const response = await request(
      fetcher,
      `https://openlibrary.org/api/books?bibkeys=ISBN:${id.id}&format=json&jscmd=data`,
      "application/json",
    );
    const book = openLibraryBook.safeParse(
      (response as Record<string, unknown> | null)?.[`ISBN:${id.id}`],
    );
    if (!book.success)
      throw new ReferenceNotFoundError("No book was found for this ISBN.");
    const { data } = book;
    const item: CslItem = {
      type: "book",
      title: data.title,
      subtitle: data.subtitle,
      author: data.authors?.map((author) => splitName(author.name)),
      publisher: data.publishers?.[0]?.name,
      "publisher-place": data.publish_places?.[0]?.name,
      issued: {
        "date-parts": [
          [
            Number(/\b\d{4}\b/.exec(data.publish_date ?? "")?.[0] ?? NaN),
          ].filter(Number.isFinite),
        ],
      },
    };
    const bibtex = cslToBibtex(item, { isbn: id.id });
    return { key: citationKey(item), bibtex, source: "isbn" };
  }

  const arxiv = id.kind === "arxiv" ? id.id.replace(/v\d+$/i, "") : undefined;
  const doi = arxiv ? `10.48550/arXiv.${arxiv}` : id.id;
  const parsed = csl.safeParse(
    await request(
      fetcher,
      doiUrl(doi),
      "application/vnd.citationstyles.csl+json",
    ),
  );
  if (!parsed.success || !parsed.data.title)
    throw new ReferenceSourceError(
      "The metadata service sent a record that could not be read.",
    );
  const item = { ...parsed.data, DOI: parsed.data.DOI ?? doi };
  return {
    key: citationKey(item),
    bibtex: cslToBibtex(item, { arxiv }),
    source: id.kind,
  };
}

const cacheSeconds = 7 * 24 * 60 * 60;
const noStore = { "Cache-Control": "no-store" };

function failure(
  error: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return Response.json(
    { error },
    { status, headers: { ...noStore, ...headers } },
  );
}

/**
 * Answers `GET /api/references?id=<DOI, arXiv ID or ISBN>` for a signed-in
 * user. Each user gets `limiter`'s budget of lookups that reach the metadata
 * services. Results are cached by ID, and cache hits don't count.
 */
export async function referenceResponse({
  request,
  userId,
  limiter,
  cache,
  fetcher = fetch,
}: {
  request: Request;
  userId: string | null;
  limiter?: RateLimit;
  cache?: Cache;
  fetcher?: Fetch;
}) {
  if (!userId) return failure("Sign in to look up references.", 401);
  const input = new URL(request.url).searchParams.get("id") ?? "";
  const id = parseReferenceId(input.slice(0, 300));
  if (!id) return failure("Enter a DOI, arXiv ID or ISBN.", 400);

  const cacheKey = new Request(
    `https://references.texfolia.invalid/${id.kind}/${encodeURIComponent(id.id.toLowerCase())}`,
  );
  const cached = await cache?.match(cacheKey).catch(() => undefined);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      headers: { ...noStore, "Content-Type": "application/json" },
    });
  }

  if (limiter) {
    const { success } = await limiter.limit({ key: userId });
    if (!success)
      return failure(
        "Too many reference lookups. Wait a minute and try again.",
        429,
        { "Retry-After": "60" },
      );
  }

  try {
    const result = await lookupReference(id, fetcher);
    const body = JSON.stringify(result);
    await cache
      ?.put(
        cacheKey,
        new Response(body, {
          headers: {
            "Cache-Control": `public, max-age=${cacheSeconds}`,
            "Content-Type": "application/json",
          },
        }),
      )
      .catch(() => {});
    return new Response(body, {
      headers: { ...noStore, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof ReferenceNotFoundError)
      return failure(error.message, 404);
    if (error instanceof ReferenceSourceError)
      return failure(error.message, 502);
    throw error;
  }
}

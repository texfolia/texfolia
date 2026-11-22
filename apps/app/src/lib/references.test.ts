import assert from "node:assert/strict";
import { test } from "node:test";

import {
  citationKey,
  cslToBibtex,
  lookupReference,
  ReferenceNotFoundError,
  ReferenceSourceError,
  referenceResponse,
  userAgent,
} from "./references.server";

// Trimmed from real doi.org, DataCite and Open Library responses.
const crossref = {
  type: "proceedings-article",
  title:
    "Efficient incident identification from multi-dimensional issue reports via meta-heuristic search",
  "container-title":
    "Proceedings of the 28th ACM Joint Meeting on European Software Engineering Conference and Symposium on the Foundations of Software Engineering",
  author: [
    { given: "Jiazhen", family: "Gu", sequence: "first" },
    { given: "Chuan", family: "Luo", sequence: "additional" },
  ],
  issued: { "date-parts": [[2020, 11, 8]] },
  page: "292-303",
  publisher: "ACM",
  "publisher-location": "New York, NY, USA",
  DOI: "10.1145/3368089.3409741",
  URL: "http://dx.doi.org/10.1145/3368089.3409741",
};
const datacite = {
  type: "article",
  author: [
    { family: "Vaswani", given: "Ashish" },
    { family: "Shazeer", given: "Noam" },
  ],
  issued: { "date-parts": [[2017]] },
  DOI: "10.48550/ARXIV.1706.03762",
  publisher: "arXiv",
  title: "Attention Is All You Need",
  URL: "https://arxiv.org/abs/1706.03762",
};
const openLibrary = {
  "ISBN:9780201529838": {
    title: "LATEX",
    subtitle:
      "a document preparation system : user's guide and reference manual",
    authors: [{ name: "Leslie Lamport" }],
    publishers: [{ name: "Addison-Wesley Pub. Co." }],
    publish_places: [{ name: "Reading, Mass" }],
    publish_date: "1994",
  },
};

function fakeFetch(
  routes: Record<string, () => Response>,
  calls: Array<{ url: string; headers: Headers }> = [],
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix),
    );
    return route ? route[1]() : new Response("<html></html>", { status: 404 });
  }) as typeof fetch;
}

test("looks up DOIs by CSL JSON content negotiation", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const result = await lookupReference(
    { kind: "doi", id: "10.1145/3368089.3409741" },
    fakeFetch(
      { "https://doi.org/10.1145/": () => Response.json(crossref) },
      calls,
    ),
  );
  assert.equal(calls[0]?.url, "https://doi.org/10.1145/3368089.3409741");
  assert.equal(
    calls[0]?.headers.get("Accept"),
    "application/vnd.citationstyles.csl+json",
  );
  assert.equal(calls[0]?.headers.get("User-Agent"), userAgent);
  assert.deepEqual(result, {
    key: "gu2020efficient",
    source: "doi",
    bibtex: `@inproceedings{gu2020efficient,
  author = {Gu, Jiazhen and Luo, Chuan},
  title = {Efficient incident identification from multi-dimensional issue reports via meta-heuristic search},
  booktitle = {Proceedings of the 28th {ACM} Joint Meeting on European Software Engineering Conference and Symposium on the Foundations of Software Engineering},
  pages = {292--303},
  publisher = {ACM},
  address = {New York, NY, USA},
  year = {2020},
  month = nov,
  doi = {10.1145/3368089.3409741},
}
`,
  });
});

test("looks up arXiv IDs through arXiv's DataCite DOIs", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const result = await lookupReference(
    { kind: "arxiv", id: "1706.03762v5" },
    fakeFetch(
      { "https://doi.org/10.48550/": () => Response.json(datacite) },
      calls,
    ),
  );
  assert.equal(calls[0]?.url, "https://doi.org/10.48550/arXiv.1706.03762");
  assert.equal(
    result.bibtex,
    `@misc{vaswani2017attention,
  author = {Vaswani, Ashish and Shazeer, Noam},
  title = {Attention Is All You Need},
  year = {2017},
  eprint = {1706.03762},
  archivePrefix = {arXiv},
  doi = {10.48550/ARXIV.1706.03762},
}
`,
  );
});

test("looks up ISBNs in Open Library", async () => {
  const result = await lookupReference(
    { kind: "isbn", id: "9780201529838" },
    fakeFetch({
      "https://openlibrary.org/api/books?bibkeys=ISBN:9780201529838&": () =>
        Response.json(openLibrary),
    }),
  );
  assert.equal(
    result.bibtex,
    `@book{lamport1994latex,
  author = {Lamport, Leslie},
  title = {{LATEX}: a document preparation system : user's guide and reference manual},
  publisher = {Addison-Wesley Pub. Co.},
  address = {Reading, Mass},
  year = {1994},
  isbn = {9780201529838},
}
`,
  );
  await assert.rejects(
    lookupReference(
      { kind: "isbn", id: "9780201529838" },
      fakeFetch({ "https://openlibrary.org/": () => Response.json({}) }),
    ),
    ReferenceNotFoundError,
  );
});

test("reports missing and failing sources", async () => {
  await assert.rejects(
    lookupReference({ kind: "doi", id: "10.9999/missing" }, fakeFetch({})),
    ReferenceNotFoundError,
  );
  await assert.rejects(
    lookupReference(
      { kind: "doi", id: "10.9999/x" },
      fakeFetch({
        "https://doi.org/": () => new Response("", { status: 503 }),
      }),
    ),
    ReferenceSourceError,
  );
  await assert.rejects(
    lookupReference({ kind: "doi", id: "10.9999/x" }, (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch),
    ReferenceSourceError,
  );
});

test("retries a dropped connection once, but not a timeout", async () => {
  let attempts = 0;
  const result = await lookupReference(
    { kind: "doi", id: "10.1145/x" },
    (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("ECONNRESET");
      return Response.json(crossref);
    }) as unknown as typeof fetch,
  );
  assert.equal(attempts, 2);
  assert.equal(result.key, "gu2020efficient");

  attempts = 0;
  await assert.rejects(
    lookupReference({ kind: "doi", id: "10.1145/x" }, (async () => {
      attempts += 1;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch),
    ReferenceSourceError,
  );
  assert.equal(attempts, 1);
});

test("escapes LaTeX specials and strips markup", () => {
  const bibtex = cslToBibtex({
    type: "article-journal",
    title: "Na<sub>2</sub>O &amp; 100% of $x_1$ in <i>vivo</i> {DNA}",
    "container-title": "Journal of R&D",
    author: [{ family: "Ŝmith", given: "J." }, { name: "CERN Collaboration" }],
    issued: { "date-parts": [[2021, 3]] },
    volume: "12",
    issue: "4",
    DOI: "10.1000/a_b",
  });
  assert.equal(
    bibtex,
    `@article{smith2021na2o,
  author = {Ŝmith, J. and {CERN Collaboration}},
  title = {{Na2O} \\& 100\\% of \\$x\\_1\\$ in vivo \\{{DNA}\\}},
  journal = {Journal of R\\&D},
  volume = {12},
  number = {4},
  year = {2021},
  month = mar,
  doi = {10.1000/a_b},
}
`,
  );
});

test("builds keys from what metadata exists", () => {
  assert.equal(
    citationKey({ type: "book", title: "The TeXbook", issued: undefined }),
    "texbook",
  );
  assert.equal(citationKey({ type: "book" }), "reference");
});

class MemoryCache {
  entries = new Map<string, string>();
  async match(request: RequestInfo | URL) {
    const body = this.entries.get(new Request(request).url);
    return body === undefined ? undefined : new Response(body);
  }
  async put(request: RequestInfo | URL, response: Response) {
    this.entries.set(new Request(request).url, await response.text());
  }
}

test("serves lookups to signed-in users within their budget", async () => {
  const request = (id: string) =>
    new Request(`https://app.test/api/references?id=${encodeURIComponent(id)}`);
  let upstream = 0;
  const fetcher = fakeFetch({
    "https://doi.org/": () => {
      upstream++;
      return Response.json(crossref);
    },
  });
  let budget = 1;
  const limiter = {
    limit: async ({ key }: { key: string }) => {
      assert.equal(key, "user-1");
      return { success: budget-- > 0 };
    },
  };
  const cache = new MemoryCache() as unknown as Cache;
  const call = (id: string, userId: string | null = "user-1") =>
    referenceResponse({
      request: request(id),
      userId,
      limiter,
      cache,
      fetcher,
    });

  assert.equal((await call("10.1145/1", null)).status, 401);
  assert.equal((await call("nonsense")).status, 400);

  const first = await call("https://doi.org/10.1145/3368089.3409741");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  assert.equal(
    ((await first.json()) as { key: string }).key,
    "gu2020efficient",
  );

  // The cached result needs neither budget nor an upstream request.
  const cached = await call("doi:10.1145/3368089.3409741");
  assert.equal(cached.status, 200);
  assert.equal(upstream, 1);

  const limited = await call("10.1145/3368089.3409742");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(upstream, 1);
});

test("maps lookup failures to statuses", async () => {
  const request = new Request("https://app.test/api/references?id=10.1000/x");
  const missing = await referenceResponse({
    request,
    userId: "u",
    fetcher: fakeFetch({}),
  });
  assert.equal(missing.status, 404);
  const failing = await referenceResponse({
    request,
    userId: "u",
    fetcher: fakeFetch({
      "https://doi.org/": () => new Response("", { status: 500 }),
    }),
  });
  assert.equal(failing.status, 502);
  assert.deepEqual(await failing.json(), {
    error: "The metadata service answered 500.",
  });
});

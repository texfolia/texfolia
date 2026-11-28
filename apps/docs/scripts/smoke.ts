import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { staticClient } from "fumadocs-core/search/client/orama-static";

const docsRoot = fileURLToPath(new URL("../", import.meta.url));
const outDir = resolve(docsRoot, "out");

assert.ok(
  existsSync(resolve(outDir, "index.html")),
  "apps/docs/out/index.html is missing; run `bun run --cwd apps/docs build` first.",
);

interface HeaderRule {
  pattern: string;
  headers: Array<[string, string]>;
}

function parseHeadersFile(filePath: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    if (/^\s/.test(rawLine)) {
      if (!current) continue;
      const colon = rawLine.indexOf(":");
      if (colon === -1) continue;
      current.headers.push([
        rawLine.slice(0, colon).trim(),
        rawLine.slice(colon + 1).trim(),
      ]);
    } else {
      current = { pattern: rawLine.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

function matchesHeaderPattern(pathname: string, pattern: string): boolean {
  if (pattern.endsWith("/*")) {
    return pathname.startsWith(pattern.slice(0, -1));
  }
  return pathname === pattern;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const headerRules = parseHeadersFile(resolve(outDir, "_headers"));

function applyCustomHeaders(
  pathname: string,
  headers: Record<string, string>,
): Record<string, string> {
  for (const rule of headerRules) {
    if (!matchesHeaderPattern(pathname, rule.pattern)) continue;
    for (const [name, value] of rule.headers) {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

// Emulates Cloudflare Workers static assets (`html_handling: "auto-trailing-slash"`)
// with `_headers` rules against the exported `./out` directory.
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  const resolved = resolve(outDir, `.${pathname}`);
  if (resolved !== outDir && !resolved.startsWith(`${outDir}${sep}`)) {
    res.writeHead(403);
    res.end();
    return;
  }

  // Exact file match (e.g. /api/search, /llms.txt, /llms.mdx/ci.md, /_next/static/...)
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const headers = applyCustomHeaders(pathname, {
      "content-type":
        MIME_TYPES[extname(resolved)] ?? "application/octet-stream",
    });
    res.writeHead(200, headers);
    res.end(readFileSync(resolved));
    return;
  }

  // Directory with index.html: enforce trailing slash with 307 redirect.
  const indexHtml = resolve(resolved, "index.html");
  if (existsSync(indexHtml) && statSync(indexHtml).isFile()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(307, { location: `${pathname}/` });
      res.end();
      return;
    }
    const headers = applyCustomHeaders(pathname, {
      "content-type": "text/html; charset=utf-8",
    });
    res.writeHead(200, headers);
    res.end(readFileSync(indexHtml));
    return;
  }

  const notFoundHtml = resolve(outDir, "404.html");
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end(existsSync(notFoundHtml) ? readFileSync(notFoundHtml) : "Not Found");
});

await new Promise<void>((resolveListen) => {
  server.listen(0, "127.0.0.1", () => resolveListen());
});

const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  // 1. Root page and all migrated guide URLs render with 200.
  const expectedPages: Array<[string, string]> = [
    ["/", "Texfolia Documentation"],
    ["/local-development/", "Local development"],
    ["/ci/", "CI selection and caches"],
    ["/editor-workspace/", "Editor workspace"],
    ["/projects/", "Projects dashboard"],
    ["/project-controls/", "Project controls in v1"],
    ["/settings/", "Settings"],
    ["/themes/", "Themes"],
    ["/git-integration/", "Git integration"],
    ["/ai-assistant/", "Configure the managed assistant"],
    ["/billing/", "Configure subscription billing"],
    ["/source-paths/", "Project path policy"],
    ["/compile-engines/", "Multiple compile engine plan"],
    ["/compile-telemetry/", "Compile telemetry"],
    ["/database-deployment/", "Set up Neon and Hyperdrive"],
    ["/auth-abuse-protection/", "Public auth abuse protection"],
    ["/security-headers/", "Web security headers"],
    ["/audits/nat-284/", "NAT-284 pre-release audit"],
    ["/release/nat-299-policy-review/", "NAT-299 policy review"],
  ];

  for (const [pathname, expectedText] of expectedPages) {
    const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
    assert.equal(res.status, 200, `${pathname} should return 200`);
    const html = await res.text();
    assert.ok(
      html.includes(expectedText),
      `${pathname} should include "${expectedText}"`,
    );
  }

  // 2. Non-trailing-slash URLs redirect to the trailing-slash canonical URL.
  for (const slug of [
    "/local-development",
    "/editor-workspace",
    "/audits/nat-284",
    "/release/nat-299-policy-review",
  ]) {
    const res = await fetch(`${baseUrl}${slug}`, { redirect: "manual" });
    assert.equal(res.status, 307, `${slug} should redirect with 307`);
    assert.equal(
      res.headers.get("location"),
      `${slug}/`,
      `${slug} should redirect to ${slug}/`,
    );
  }

  // 3. Static search index serves JSON and answers real Fumadocs static search queries.
  const searchRes = await fetch(`${baseUrl}/api/search`);
  assert.equal(searchRes.status, 200, "/api/search should return 200");
  assert.ok(
    searchRes.headers.get("content-type")?.includes("application/json"),
    "/api/search should serve application/json via _headers",
  );
  const searchClient = staticClient({ from: `${baseUrl}/api/search` });

  for (const [term, expectedUrl] of [
    ["Hyperdrive", "/database-deployment"],
    ["NAT-284", "/audits/nat-284"],
    ["Editor workspace", "/editor-workspace"],
  ] as const) {
    const results = await searchClient.search(term);
    const urls = results.map((hit) => hit.url);
    assert.ok(
      urls.some((url) => url.startsWith(expectedUrl)),
      `search for "${term}" should match ${expectedUrl} (got ${urls.join(", ")})`,
    );
  }

  // 4. llms.txt, llms-full.txt, and per-page Markdown files are served.
  const llmsRes = await fetch(`${baseUrl}/llms.txt`);
  assert.equal(llmsRes.status, 200, "/llms.txt should return 200");
  const llmsText = await llmsRes.text();
  const mdLinks = [...llmsText.matchAll(/\]\((\/llms\.mdx\/[^)]+\.md)\)/g)].map(
    (match) => match[1]!,
  );
  assert.equal(
    mdLinks.length,
    expectedPages.length,
    `/llms.txt should link to all ${expectedPages.length} pages (found ${mdLinks.length})`,
  );

  for (const mdPath of mdLinks) {
    const res = await fetch(`${baseUrl}${mdPath}`);
    assert.equal(res.status, 200, `${mdPath} should return 200`);
    const body = await res.text();
    assert.ok(body.startsWith("# "), `${mdPath} should start with a heading`);
  }

  const llmsFullRes = await fetch(`${baseUrl}/llms-full.txt`);
  assert.equal(llmsFullRes.status, 200, "/llms-full.txt should return 200");
  const llmsFullText = await llmsFullRes.text();
  assert.ok(
    llmsFullText.includes("Local development") &&
      llmsFullText.includes("NAT-284 pre-release audit"),
    "/llms-full.txt should include full guide contents",
  );

  // 5. Static asset cache headers and 404 fallback work.
  const homeHtml = readFileSync(resolve(outDir, "index.html"), "utf8");
  const staticAssetMatch = homeHtml.match(/(\/_next\/static\/[^"']+\.css)/);
  assert.ok(
    staticAssetMatch?.[1],
    "index.html should reference a static CSS asset",
  );
  const assetRes = await fetch(`${baseUrl}${staticAssetMatch[1]}`);
  assert.equal(assetRes.status, 200);
  assert.equal(
    assetRes.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );

  const missingRes = await fetch(`${baseUrl}/does-not-exist/`);
  assert.equal(missingRes.status, 404, "unknown path should return 404");

  console.info(
    `Docs smoke check passed (${expectedPages.length} pages, redirects, ZBSearch queries, llms.txt, llms-full.txt, ${mdLinks.length} markdown routes, and static cache headers).`,
  );
} finally {
  server.close();
}

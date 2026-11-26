import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FormatResponse } from "@texfolia/editor";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium, type Browser } from "playwright";

import { pdfFixture } from "./pdf-fixture";

const client = new URL("../dist/client/", import.meta.url);
const assets = await readdir(new URL("assets/", client));
function asset(pattern: RegExp) {
  const name = assets.find((name) => pattern.test(name));
  assert(name, `Missing production asset: ${pattern}`);
  return `/assets/${name}`;
}
asset(/^styles-.*\.css$/);
const formatter = asset(/^format\.worker-.*\.js$/);
const texFmtWasm = asset(/^tex_fmt_bg-.*\.wasm$/);
const pdf = asset(/^pdf\.worker\.min-.*\.mjs$/);
const cssFiles = assets.filter((name) => name.endsWith(".css"));
for (const name of cssFiles) {
  const url = new URL(`assets/${name}`, client);
  const css = await readFile(url, "utf8");
  for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    const reference = match[1];
    assert(reference);
    if (reference.startsWith("data:")) continue;
    const target = reference.startsWith("/")
      ? new URL(reference.slice(1), client)
      : new URL(reference, url);
    assert(await Bun.file(target).exists(), `Missing CSS asset: ${target}`);
  }
}
const javascript = (
  await Promise.all(
    assets
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(new URL(`assets/${name}`, client), "utf8")),
  )
).join("\n");
for (const worker of [formatter, pdf])
  assert(javascript.includes(worker), `Worker is not referenced: ${worker}`);

// Every page loads the root route's scripts, so what its modules import counts
// against all of them.
const root = new URL("../dist/server/", import.meta.url).pathname;
const serverAssets = await readdir(join(root, "assets"));
const manifestFile = serverAssets.find((name) =>
  name.startsWith("_tanstack-start-manifest"),
);
assert(manifestFile, "Missing route manifest");
const { tsrStartManifest } = (await import(
  join(root, "assets", manifestFile)
)) as {
  tsrStartManifest: () => {
    routes: { __root__: { preloads: (string | { href: string })[] } };
  };
};
const rootScripts = new Map<string, string>();
const pendingScripts = tsrStartManifest().routes.__root__.preloads.flatMap(
  (preload) =>
    (typeof preload === "string" ? preload : preload.href).split("/").at(-1) ??
    [],
);
for (let name = pendingScripts.pop(); name; name = pendingScripts.pop()) {
  if (rootScripts.has(name) || !name.endsWith(".js")) continue;
  const source = await readFile(new URL(`assets/${name}`, client), "utf8");
  rootScripts.set(name, source);
  for (const match of source.matchAll(
    /(?:from|import)\s*["'`]\.\/([^"'`]+\.js)["'`]/g,
  ))
    if (match[1]) pendingScripts.push(match[1]);
}
const rootBytes = [...rootScripts.values()].reduce(
  (total, source) => total + Buffer.byteLength(source),
  0,
);
assert(rootBytes > 100_000, "The root scripts were not found");
assert(
  rootBytes < 700 * 1024,
  `Every page loads ${Math.round(rootBytes / 1024)} KiB of scripts; the budget is 700 KiB`,
);
for (const [library, marker] of [
  ["CodeMirror", "cm-editor"],
  ["Zod", "invalid_union"],
  ["TanStack DB", "CollectionConfigurationError"],
] as const) {
  assert(javascript.includes(marker), `${library} no longer has ${marker}`);
  for (const [name, source] of rootScripts)
    assert(!source.includes(marker), `Every page loads ${library} in ${name}`);
}

const modules = await readdir(root, { recursive: true });
const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = reservation.port;
await reservation.stop(true);
assert(port);
const runtime = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "production-assets-test",
    modules: modules
      .filter((path) => path.endsWith(".js"))
      .sort((a, b) =>
        a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
      )
      .map((path) => ({ type: "ESModule", path: join(root, path) })),
    modulesRoot: root,
    compatibilityDate: "2026-10-31",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      directory: client.pathname,
      routerConfig: { has_user_worker: true },
    },
    durableObjects: {
      COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
    },
    r2Buckets: ["SOURCES"],
    // Public pages and unauthenticated session checks must not query Postgres.
    hyperdrives: {
      HYPERDRIVE: "postgres://unused:unused@127.0.0.1:1/unused",
    },
    bindings: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      BETTER_AUTH_SECRET:
        "production-assets-test-secret-at-least-32-characters",
      STRIPE_SECRET_KEY: "sk_test_production_assets",
      ...Object.fromEntries(
        ["GITHUB", "GOOGLE", "GITLAB", "MICROSOFT"].flatMap((provider) => [
          [`${provider}_CLIENT_ID`, "fixture"],
          [`${provider}_CLIENT_SECRET`, "fixture"],
        ]),
      ),
    },
  }),
  port,
});
let browser: Browser | undefined;
try {
  const origin = (await runtime.ready).origin;
  for (const path of [formatter, texFmtWasm, "/dictionaries/en-US.aff"]) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200, path);
    await response.body?.cancel();
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
      path,
    );
  }
  const loginPage = await (await fetch(new URL("/login", origin))).text();
  assert.match(
    loginPage,
    /<link rel="preload" href="\/assets\/geist-latin-wght-normal-[^"]+\.woff2" as="font"/,
  );
  const nonces = new Set<string>();
  for (const path of ["/", "/login", "/api/auth/get-session", "/projects"]) {
    const response = await runtime.dispatchFetch(new URL(path, origin), {
      redirect: "manual",
      headers: { "x-texfolia-csp-nonce": "attacker-controlled" },
    });
    assert.equal(response.headers.get("X-Frame-Options"), "SAMEORIGIN", path);
    assert.equal(
      response.headers.get("X-Content-Type-Options"),
      "nosniff",
      path,
    );
    assert.equal(
      response.headers.get("Referrer-Policy"),
      "strict-origin-when-cross-origin",
      path,
    );
    const policy = response.headers.get("Content-Security-Policy");
    assert(policy, `Missing enforced CSP on ${path}`);
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "script-src-attr 'none'",
    ])
      assert(policy.includes(directive), `Missing ${directive} on ${path}`);
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
    assert(
      nonce && nonce !== "attacker-controlled",
      `Invalid nonce on ${path}`,
    );
    assert(!nonces.has(nonce), "Each response must have a fresh nonce");
    nonces.add(nonce);
    if (path === "/") {
      assert.equal(response.status, 307, path);
      assert.equal(
        new URL(response.headers.get("Location") ?? "", origin).pathname,
        "/projects",
      );
      continue;
    }
    assert.equal(response.status, 200, path);
    const body = await response.text();
    if (response.headers.get("Content-Type")?.includes("text/html")) {
      const scripts = [...body.matchAll(/<script\b([^>]*)>/g)];
      assert(scripts.length > 0, `Missing document scripts on ${path}`);
      for (const script of scripts)
        assert(
          script[1]?.includes(`nonce="${nonce}"`),
          `Missing script nonce on ${path}`,
        );
    }
  }
  const health = await fetch(new URL("/api/health", origin));
  assert.equal(health.status, 503, "No database answers here");
  assert.deepEqual(await health.json(), { status: "unavailable" });
  browser = await chromium.launch({ headless: true });
  // `/` redirects to /login, whose Turnstile widget rejects the empty test site key.
  const context = await browser.newContext();
  await context.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.turnstile = { render() { return "widget"; }, reset() {}, remove() {}, execute() {}, getResponse() { return ""; }, isExpired() { return false; } };
window[new URL(document.currentScript.src).searchParams.get("onload")]?.();`,
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy/i.test(message.text())
    )
      errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(request.url()));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.route("**/pdfjs.mjs", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      path: new URL(import.meta.resolve("pdfjs-dist/build/pdf.mjs")).pathname,
    }),
  );
  await page.goto(origin);
  const fonts = await page.evaluate(async () => {
    const loaded = await document.fonts.load('16px "Geist Variable"');
    const code = document.createElement("code");
    code.className = "font-mono";
    code.textContent = "LaTeX";
    document.body.appendChild(code);
    return {
      loaded: loaded.length,
      sans: getComputedStyle(document.body).fontFamily,
      mono: getComputedStyle(code).fontFamily,
    };
  });
  assert(fonts.loaded > 0, "Geist font did not load");
  assert.match(fonts.sans, /Geist Variable/);
  assert.match(fonts.mono, /monospace/);

  const source = "\\begin{itemize}\n\\item Hello\n\\end{itemize}\n";
  const response = await page.evaluate(
    ({ formatter, source }) =>
      new Promise<FormatResponse>((resolve, reject) => {
        const worker = new Worker(formatter, { type: "module" });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Production formatter timed out"));
        }, 15_000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.message));
        };
        worker.onmessage = ({ data }: MessageEvent<FormatResponse>) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(data);
        };
        worker.postMessage({
          source,
          settings: { indent: 2, wrap: true, width: 80 },
        });
      }),
    { formatter, source },
  );
  assert(!("error" in response), JSON.stringify(response));
  let formatted = source;
  for (const change of [...response.changes].reverse())
    formatted =
      formatted.slice(0, change.from) +
      change.insert +
      formatted.slice(change.to);
  assert.equal(formatted, "\\begin{itemize}\n  \\item Hello\n\\end{itemize}\n");

  const pdfReady = await page.evaluate(
    async ({ pdf, library, data }) => {
      const pdfjs: typeof import("pdfjs-dist") = await import(library);
      pdfjs.GlobalWorkerOptions.workerSrc = pdf;
      const worker = new pdfjs.PDFWorker();
      try {
        await Promise.race([
          worker.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("PDF worker timed out")), 15_000),
          ),
        ]);
        const realWorker = worker.port instanceof Worker;
        const loading = pdfjs.getDocument({
          data: new Uint8Array(data),
          worker,
          useSystemFonts: true,
        });
        try {
          const document = await loading.promise;
          const page = await document.getPage(1);
          const canvas = window.document.createElement("canvas");
          const viewport = page.getViewport({ scale: 1 });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, viewport }).promise;
          return realWorker && document.numPages === 1;
        } finally {
          await loading.destroy();
        }
      } finally {
        worker.destroy();
      }
    },
    {
      pdf,
      library: new URL("/pdfjs.mjs", origin).href,
      data: [...pdfFixture()],
    },
  );
  assert(pdfReady, "PDF.js did not initialize a real PDF worker");
  assert.deepEqual(errors, []);

  const probe = await context.newPage();
  await probe.goto(origin);
  const blocked = await probe.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("CSP did not block the inline script")),
          5000,
        );
        document.addEventListener(
          "securitypolicyviolation",
          (event) => {
            clearTimeout(timer);
            resolve(`${event.disposition}:${event.effectiveDirective}`);
          },
          { once: true },
        );
        const script = document.createElement("script");
        script.textContent = "document.body.dataset.injected = 'yes'";
        document.head.appendChild(script);
      }),
  );
  assert.equal(blocked, "enforce:script-src-elem");
  assert.equal(await probe.locator("body").getAttribute("data-injected"), null);
  await probe.close();
  const login = Bun.spawn(
    ["bun", "run", new URL("./login.ts", import.meta.url).pathname],
    {
      env: { ...process.env, LOGIN_TEST_BASE_URL: origin },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  assert.equal(
    await login.exited,
    0,
    "Production login flow must work under CSP",
  );
  console.info(
    "Production document/API security headers, script nonces, CSS, fonts, formatter JS/WASM, and PDF worker verified.",
  );
} finally {
  await browser?.close();
  await runtime.dispose();
}

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const web = "apps/app/";
const test = `${web}test/`;

// Browser suites load the entire app. Keep runtime inputs broad. Suites run in
// the Postgres job unless they name another.
export const suites = {
  settings: { inputs: ["settings.ts"] },
  pricing: { inputs: ["pricing.ts"], build: true, browser: true },
  login: { job: "browser", inputs: ["login.ts"], browser: true },
  "editor-keymaps": {
    job: "browser",
    inputs: ["editor-keymaps.ts", "editor-keymaps/"],
    browser: true,
  },
  spelling: {
    job: "browser",
    inputs: ["spelling.ts", "spelling/"],
    browser: true,
  },
  synctex: {
    job: "browser",
    inputs: [
      "synctex.ts",
      "fixtures/synctex/",
      "editor-runtime/",
      "workspace-upload/",
    ],
    browser: true,
  },
  themes: {
    job: "browser",
    inputs: ["theme-preview.ts", "editor-runtime/", "workspace-upload/"],
    browser: true,
  },
  "editor-runtime": {
    job: "browser",
    inputs: [
      "editor-runtime.ts",
      "editor-runtime/",
      "workspace-upload/",
      "pdf-fixture.ts",
    ],
    browser: true,
  },
  "editor-features": {
    job: "browser",
    inputs: [
      "editor-features.ts",
      "editor-runtime/",
      "workspace-upload/",
      "pdf-fixture.ts",
    ],
    browser: true,
  },
  "workspace-accessibility": {
    job: "browser",
    inputs: [
      "workspace-accessibility.ts",
      "editor-runtime/",
      "workspace-upload/",
      "pdf-fixture.ts",
    ],
    browser: true,
  },
  "compile-engine": { job: "engine", inputs: ["compile-engine.ts"] },
  "workspace-upload": {
    job: "engine",
    inputs: ["workspace-upload.ts", "workspace-upload/", "editor-runtime/"],
    browser: true,
  },
  database: { inputs: ["postgres.ts", "postgres/"] },
  "compile-route": { inputs: ["compile-route.ts", "compile-route/"] },
  "ai-billing": { inputs: ["ai-billing.ts"] },
  assistant: { inputs: ["ai-assistant.ts"], build: true, browser: true },
  collaboration: {
    inputs: [
      "collaboration.ts",
      "collaboration/",
      "collaboration-cache.ts",
      "collaboration-cache/",
    ],
    browser: true,
  },
  "workspace-metadata": {
    inputs: ["workspace-metadata.ts"],
    build: true,
    browser: true,
  },
  "ui-overhaul": {
    inputs: ["ui-overhaul.ts", "pdf-fixture.ts"],
    build: true,
    browser: true,
  },
  git: { inputs: ["git-integration.ts", "git/"] },
  "source-storage": {
    inputs: ["source-storage.ts", "source-storage/", "worker-integration.ts"],
  },
  projects: { inputs: ["projects.ts", "projects/", "worker-integration.ts"] },
};

// Run in Checks, with the production build.
const productionAssetInputs = [
  "production-assets.ts",
  "login.ts",
  "pdf-fixture.ts",
];

function matches(path, input) {
  return input.endsWith("/") ? path.startsWith(input) : path === input;
}

function documentation(path) {
  return (
    /(^|\/)README\.md$/.test(path) ||
    ["apps/docs/src/content/docs/", ".agents/", ".zed/"].some((input) =>
      path.startsWith(input),
    ) ||
    path === "LICENSE"
  );
}

function requiresFullRun(path) {
  if (
    path.startsWith("packages/") ||
    path.startsWith(".github/") ||
    path.startsWith("scripts/") ||
    /(^|\/)(\.env[^/]*|\.dev\.vars[^/]*|[^/]*schema[^/]*|(?:[^/]*[-.])?env(?:[-.][^/]*)?|environment(?:\.[^/]*)?|wrangler\.[^/]+|worker-configuration\.d\.ts)(\/|$)/.test(
      path,
    )
  )
    return true;
  if (documentation(path)) return false;
  return !path.startsWith(web) && !path.startsWith("apps/compiler/");
}

export function selectChecks(paths, { fallback = false } = {}) {
  const full = fallback || paths.some(requiresFullRun);
  const webChanged =
    full || paths.some((path) => path.startsWith(web) && !documentation(path));
  const compiler =
    full ||
    paths.some(
      (path) => path.startsWith("apps/compiler/") && !documentation(path),
    );
  const crossPackage = paths.some(
    (path) =>
      path.startsWith("apps/compiler/src/") ||
      path === "apps/compiler/scripts/engine-client.ts",
  );
  const runtime = paths.some(
    (path) =>
      path.startsWith(web) &&
      !documentation(path) &&
      !path.startsWith(test) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
  );
  const changed = (inputs) =>
    paths.some((path) => inputs.some((input) => matches(path, test + input)));
  const unknownTest = paths.some(
    (path) =>
      path.startsWith(test) &&
      ![
        ...Object.values(suites).flatMap((suite) => suite.inputs),
        ...productionAssetInputs,
      ].some((input) => matches(path, test + input)),
  );
  const selected = Object.fromEntries(
    Object.entries(suites).map(([name, suite]) => [
      name,
      full ||
        runtime ||
        unknownTest ||
        (crossPackage && name === "compile-route") ||
        // The engine's image holds everything in the compiler.
        (compiler && suite.job === "engine") ||
        changed(suite.inputs),
    ]),
  );
  const productionAssets =
    full || runtime || unknownTest || changed(productionAssetInputs);
  const inJob = (job, setup = () => true) =>
    Object.entries(suites).some(
      ([name, suite]) =>
        selected[name] && (suite.job ?? "postgres") === job && setup(suite),
    );
  return {
    full,
    compiler,
    "web-checks": webChanged || crossPackage,
    "package-checks": webChanged || compiler,
    "cross-package": crossPackage,
    "production-assets": productionAssets,
    postgres: inJob("postgres"),
    "postgres-build": inJob("postgres", (suite) => suite.build),
    "postgres-browser": inJob("postgres", (suite) => suite.browser),
    browser: inJob("browser"),
    engine: inJob("engine"),
    ...selected,
  };
}

export function changedPaths(base, head = "HEAD", cwd = process.cwd()) {
  // Include both sides of renames so moving a suite input cannot skip its owner.
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = process.env.CI_BASE_SHA;
  let plan;
  let filter = "";
  try {
    // Pushes to main check the merged result in full, not only the pushed diff.
    if (process.env.CI_FULL_RUN === "true")
      throw new Error("Full run requested for a push to main");
    if (!base || !/^[a-f0-9]{40}$/.test(base))
      throw new Error("Missing PR base SHA");
    plan = selectChecks(changedPaths(base));
    if (!plan.full) {
      filter = `--filter=...[${base}]`;
      if (plan["cross-package"]) filter += " --filter=app";
      if (!plan.compiler) filter += " --filter=!compiler";
      if (!plan["web-checks"]) filter += " --filter=!app";
    }
  } catch (error) {
    console.warn(`Running all checks: ${error.message}`);
    plan = selectChecks([], { fallback: true });
  }
  const outputs = { ...plan, "turbo-filter": filter };
  console.info(JSON.stringify(outputs, null, 2));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
}

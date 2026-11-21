import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const web = "apps/app/";
const test = `${web}test/`;

// Production browser suites load the entire app. Keep runtime inputs broad.
export const suites = {
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
  templates: {
    inputs: ["templates.ts", "templates/", "worker-integration.ts"],
  },
  "template-seed": { inputs: [] },
  "template-lifecycle": {
    inputs: ["template-lifecycle.ts", "template-pages.ts"],
    build: true,
    browser: true,
  },
};

function matches(path, input) {
  return input.endsWith("/") ? path.startsWith(input) : path === input;
}

function documentation(path) {
  return (
    /(^|\/)README\.md$/.test(path) ||
    ["docs/", ".agents/", ".audit/", ".zed/"].some((input) =>
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
  const crossPackage = paths.some((path) =>
    path.startsWith("apps/compiler/src/"),
  );
  const runtime = paths.some(
    (path) =>
      path.startsWith(web) &&
      !documentation(path) &&
      !path.startsWith(test) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
  );
  const unknownTest = paths.some(
    (path) =>
      path.startsWith(test) &&
      !Object.values(suites).some((suite) =>
        suite.inputs.some((input) => matches(path, test + input)),
      ) &&
      path !== `${test}production-assets.ts`,
  );
  const selected = Object.fromEntries(
    Object.entries(suites).map(([name, suite]) => [
      name,
      full ||
        runtime ||
        unknownTest ||
        (crossPackage &&
          ["compile-route", "template-lifecycle"].includes(name)) ||
        paths.some((path) =>
          suite.inputs.some((input) => matches(path, test + input)),
        ),
    ]),
  );
  const productionAssets =
    full ||
    runtime ||
    unknownTest ||
    paths.includes(`${test}production-assets.ts`);
  return {
    full,
    compiler,
    "web-checks": webChanged || crossPackage,
    "package-checks": webChanged || compiler,
    "cross-package": crossPackage,
    "production-assets": productionAssets,
    postgres: Object.values(selected).some(Boolean),
    "postgres-build": Object.entries(suites).some(
      ([name, suite]) => selected[name] && suite.build,
    ),
    "postgres-browser": Object.entries(suites).some(
      ([name, suite]) => selected[name] && suite.browser,
    ),
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

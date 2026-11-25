import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { changedPaths, selectChecks, suites } from "./ci-select.mjs";

function selectedSuites(plan) {
  return Object.keys(suites).filter((name) => plan[name]);
}

test("documentation keeps repository checks but skips package tests and browsers", () => {
  const plan = selectChecks([
    "apps/docs/src/content/docs/projects.md",
    "apps/app/src/lib/builds/README.md",
  ]);
  for (const key of [
    "full",
    "compiler",
    "web-checks",
    "package-checks",
    "production-assets",
    "postgres",
    "browser",
    "engine",
  ])
    assert.equal(plan[key], false, key);
});

test("Go-only changes run compiler and engine checks without browser or database suites", () => {
  const plan = selectChecks(["apps/compiler/engine/compile.go"]);
  assert.deepEqual(selectedSuites(plan), [
    "compile-engine",
    "workspace-upload",
  ]);
  assert.equal(plan.compiler, true);
  assert.equal(plan.engine, true);
  assert.equal(plan.browser, false);
  assert.equal(plan["package-checks"], true);
  assert.equal(plan["web-checks"], false);
  assert.equal(plan.postgres, false);
  assert.equal(plan["production-assets"], false);
});

test("compiler runtime changes also exercise its web consumers", () => {
  const plan = selectChecks(["apps/compiler/src/local.ts"]);
  assert.equal(plan["web-checks"], true);
  assert.equal(plan["cross-package"], true);
  assert.deepEqual(selectedSuites(plan), [
    "compile-engine",
    "workspace-upload",
    "compile-route",
    "template-lifecycle",
  ]);
  assert.equal(plan["postgres-build"], true);
});

test("shared contract fixtures run every check", () => {
  const plan = selectChecks(["packages/contracts/fixtures/path-policy.json"]);
  assert.equal(plan.full, true);
  assert.equal(plan.compiler, true);
  assert.equal(plan["web-checks"], true);
});

test("web unit-only changes skip integration and production assets", () => {
  const plan = selectChecks(["apps/app/src/lib/shortcuts/shortcuts.test.ts"]);
  assert.equal(plan["web-checks"], true);
  assert.equal(plan.compiler, false);
  assert.equal(plan.postgres, false);
  assert.equal(plan.browser, false);
  assert.equal(plan.engine, false);
  assert.equal(plan["production-assets"], false);
});

test("every mapped test input selects its owners and required setup", () => {
  for (const suite of Object.values(suites)) {
    for (const input of suite.inputs) {
      const path = `apps/app/test/${input}${input.endsWith("/") ? "worker.ts" : ""}`;
      const plan = selectChecks([path]);
      const owners = Object.entries(suites).filter(([, candidate]) =>
        candidate.inputs.includes(input),
      );
      assert.deepEqual(
        selectedSuites(plan),
        owners.map(([name]) => name),
        path,
      );
      const jobOwners = (job) =>
        owners.flatMap(([, owner]) =>
          (owner.job ?? "postgres") === job ? [owner] : [],
        );
      for (const job of ["postgres", "browser", "engine"])
        assert.equal(plan[job], jobOwners(job).length > 0, `${path}: ${job}`);
      for (const setup of ["build", "browser"])
        assert.equal(
          plan[`postgres-${setup}`],
          jobOwners("postgres").some((owner) => Boolean(owner[setup])),
          `${path}: ${setup}`,
        );
    }
  }
});

test("production asset test changes need only the Checks build and browser", () => {
  const plan = selectChecks(["apps/app/test/production-assets.ts"]);
  assert.equal(plan["production-assets"], true);
  assert.equal(plan.postgres, false);
  for (const input of ["login.ts", "pdf-fixture.ts"])
    assert.equal(
      selectChecks([`apps/app/test/${input}`])["production-assets"],
      true,
      input,
    );
});

test("every selected suite runs in its own job", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const jobs = Object.fromEntries(
    workflow
      .split(/^jobs:$/m)[1]
      .split(/^ {2}(?=[\w-]+:$)/m)
      .slice(1)
      .map((job) => [job.slice(0, job.indexOf(":")), job]),
  );
  for (const [name, { job = "postgres" }] of Object.entries(suites))
    for (const [id, source] of Object.entries(jobs))
      assert.equal(
        source.includes(`if: steps.select.outputs.${name} == 'true'`),
        id === job,
        `${name} in ${id}`,
      );
});

test("runtime web changes keep every integration suite", () => {
  for (const path of [
    "apps/app/src/components/editor.tsx",
    "apps/app/public/logo.svg",
    "apps/app/vite.config.ts",
  ]) {
    const plan = selectChecks([path]);
    assert.deepEqual(selectedSuites(plan), Object.keys(suites), path);
    assert.equal(plan["production-assets"], true, path);
  }
});

test("shared, lockfile, CI, environment, schema, and unknown root changes select everything", () => {
  for (const path of [
    "packages/db/src/index.ts",
    "packages/tsconfig/base.json",
    "bun.lock",
    "package.json",
    "turbo.json",
    ".github/workflows/ci.yml",
    ".github/actions/setup-ci/action.yml",
    "scripts/ci-select.mjs",
    ".oxfmtrc.json",
    "apps/app/.env.local",
    "apps/app/.dev.vars",
    "apps/app/src/env.ts",
    "apps/app/src/vite-env.d.ts",
    "apps/compiler/src/environment.ts",
    "apps/app/src/env/config.ts",
    "apps/app/src/lib/projects/project.schema.ts",
    "apps/compiler/wrangler.jsonc",
    "apps/app/worker-configuration.d.ts",
    "new-build-config.json",
  ]) {
    const plan = selectChecks([path]);
    assert.equal(plan.full, true, path);
    assert.equal(plan.compiler, true, path);
    assert.equal(plan["web-checks"], true, path);
    assert.equal(plan["production-assets"], true, path);
    assert.deepEqual(selectedSuites(plan), Object.keys(suites), path);
  }
});

test("unmapped test helpers fall back to all integration suites", () => {
  assert.deepEqual(
    selectedSuites(selectChecks(["apps/app/test/new-helper.ts"])),
    Object.keys(suites),
  );
  assert.equal(
    selectChecks(["apps/app/test/new-helper.ts"])["production-assets"],
    true,
  );
  assert.equal(selectChecks([], { fallback: true }).full, true);
});

test("multiple changes select the union", () => {
  assert.deepEqual(
    selectedSuites(
      selectChecks([
        "apps/app/test/collaboration/browser.ts",
        "apps/app/test/ai-assistant.ts",
      ]),
    ),
    ["assistant", "collaboration"],
  );
});

test("PR diff uses the merge base and preserves deleted and renamed inputs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "texfolia-ci-select-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "CI selector test");
    writeFileSync(join(cwd, "collaboration.ts"), "fixture");
    git("add", ".");
    git("commit", "-m", "base");
    git("checkout", "-b", "pr");
    git("mv", "collaboration.ts", "renamed.ts");
    git("commit", "-m", "rename suite input");
    const head = git("rev-parse", "HEAD");
    git("checkout", "main");
    writeFileSync(join(cwd, "unrelated-main.ts"), "base branch advanced");
    git("add", ".");
    git("commit", "-m", "advance main");
    assert.deepEqual(changedPaths("main", head, cwd).sort(), [
      "collaboration.ts",
      "renamed.ts",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("real Turbo filtering and hashes cover package and cross-package inputs", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "texfolia-ci-turbo-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  const turbo = (
    filter = [],
    tasks = ["test", "typecheck", "lint", "format:check"],
  ) =>
    JSON.parse(
      execFileSync(
        join(root, "node_modules/.bin/turbo"),
        ["run", ...tasks, "--dry=json", ...filter],
        {
          cwd,
          encoding: "utf8",
          env: process.env,
        },
      ),
    );
  try {
    for (const path of [
      "package.json",
      "bun.lock",
      "turbo.json",
      "tsconfig.json",
      ".oxfmtrc.json",
      ".oxlintrc.json",
      ".gitignore",
      "apps/app/package.json",
      "apps/compiler/package.json",
      "packages/contracts/package.json",
      "packages/db/package.json",
      "packages/tsconfig/package.json",
      "packages/tsconfig/base.json",
    ]) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      copyFileSync(join(root, path), join(cwd, path));
    }
    for (const path of [
      "apps/compiler/src/local.ts",
      "packages/contracts/fixtures/path-policy.json",
      "apps/compiler/engine/compile.go",
      "apps/app/src/lib/shortcuts/shortcuts.test.ts",
      "packages/db/src/index.ts",
    ])
      write(path, "base input");
    git("init", "-b", "main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "CI selector test");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const hashes = Object.fromEntries(
      turbo().tasks.map((task) => [task.taskId, task.hash]),
    );
    for (const [path, expectedPackages, invalidated] of [
      ["apps/docs/src/content/docs/ci.md", [], []],
      [
        "apps/compiler/engine/compile.go",
        ["@texfolia/contracts", "@texfolia/db", "compiler"],
        ["compiler#test", "compiler#lint"],
      ],
      [
        "apps/app/src/lib/shortcuts/shortcuts.test.ts",
        ["@texfolia/contracts", "@texfolia/db", "app"],
        ["app#test"],
      ],
      [
        "apps/compiler/src/local.ts",
        ["@texfolia/contracts", "@texfolia/db", "app", "compiler"],
        ["app#typecheck"],
      ],
      [
        "packages/contracts/fixtures/path-policy.json",
        ["@texfolia/contracts", "@texfolia/db", "app", "compiler"],
        ["@texfolia/contracts#test", "compiler#test", "app#typecheck"],
      ],
      [
        "packages/db/src/index.ts",
        ["@texfolia/contracts", "@texfolia/db", "app", "compiler"],
        ["app#test", "compiler#test", "app#typecheck"],
      ],
      [
        "packages/tsconfig/base.json",
        ["@texfolia/contracts", "@texfolia/db", "app", "compiler"],
        [
          "@texfolia/contracts#typecheck",
          "@texfolia/db#typecheck",
          "app#typecheck",
          "compiler#typecheck",
        ],
      ],
      [
        ".github/workflows/ci.yml",
        ["@texfolia/contracts", "@texfolia/db", "app", "compiler"],
        ["app#test", "compiler#test"],
      ],
    ]) {
      git("reset", "--hard", base);
      git("clean", "-fd");
      write(path, "changed input");
      git("add", ".");
      git("commit", "-m", "change input");
      const outputs = join(cwd, "outputs");
      execFileSync(process.execPath, [join(root, "scripts/ci-select.mjs")], {
        cwd,
        env: {
          ...process.env,
          CI_BASE_SHA: base,
          CI_FULL_RUN: "false",
          GITHUB_OUTPUT: outputs,
        },
      });
      const filter = readFileSync(outputs, "utf8")
        .split("\n")
        .find((line) => line.startsWith("turbo-filter="))
        .slice("turbo-filter=".length);
      const result = turbo(filter ? filter.split(" ") : []);
      const packages = [
        ...new Set(
          result.tasks
            .filter((task) => task.command && task.command !== "<NONEXISTENT>")
            .map((task) => task.package),
        ),
      ].sort();
      assert.deepEqual(packages, expectedPackages, path);
      const updated = Object.fromEntries(
        result.tasks.map((task) => [task.taskId, task.hash]),
      );
      for (const task of invalidated)
        assert.notEqual(updated[task], hashes[task], [path, task].join(": "));
    }
    git("reset", "--hard", base);
    git("clean", "-fdx");
    const buildHash = () =>
      turbo(["--filter=app"], ["build"]).tasks.find(
        (task) => task.taskId === "app#build",
      ).hash;
    const before = buildHash();
    write("apps/app/dist/server/.dev.vars", "GENERATED=true");
    assert.equal(
      buildHash(),
      before,
      "generated environment output must not invalidate its own build",
    );
    write("apps/app/.env.ci-test", "VITE_TEST=changed");
    assert.notEqual(
      buildHash(),
      before,
      "source environment files must invalidate the build",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pushes to main run every check without a Turbo filter", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "texfolia-ci-push-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "CI selector test");
    writeFileSync(join(cwd, "README.md"), "base");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "README.md"), "documentation only");
    git("commit", "-am", "docs");
    const outputs = join(cwd, "outputs");
    execFileSync(process.execPath, [join(root, "scripts/ci-select.mjs")], {
      cwd,
      env: {
        ...process.env,
        CI_BASE_SHA: base,
        CI_FULL_RUN: "true",
        GITHUB_OUTPUT: outputs,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const plan = Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    assert.equal(plan["turbo-filter"], "");
    for (const key of [
      "full",
      "compiler",
      "package-checks",
      "production-assets",
      "postgres",
      ...Object.keys(suites),
    ])
      assert.equal(plan[key], "true", key);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

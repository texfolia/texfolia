import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  projectCollaborator,
  projectJob,
  projectNode,
  session,
  subscription,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { z } from "zod";

import type { Engine } from "../../compiler/src/jobs";
import { createLocalRuntime } from "../../compiler/src/local";
import { sourceDeltaSchema } from "../../compiler/src/source-sync";
import { unknownEngineTiming } from "../../compiler/src/telemetry";
import { hashSource } from "../src/lib/latex/source-sync";
import { projectMetadataVersion } from "../src/lib/project-metadata";
import { readProjectMetadata } from "../src/lib/project-metadata.server";
import { createProject } from "../src/lib/project.server";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres test database",
);
const db = createDb(connectionString);
const directory = await mkdtemp(join(tmpdir(), "texfolia-compile-route-"));
const secret = "compile-route-integration-secret-not-for-production";
const cookies = new Map<string, string>();
const accepted = z.object({
  id: z.uuid(),
  statusUrl: z.string(),
  revision: z.number().optional(),
  sourceRevision: z.number().optional(),
});
const submissions: Array<{ id: string; body: unknown; status: number }> = [];
const expectedSources = new Map<
  string,
  Record<string, string | { base64: string }>
>();
let engineCalls = 0;
const engine: Engine = async (project, context) => {
  engineCalls++;
  const expected = expectedSources.get(context.projectId ?? "");
  if (expected) {
    assert("kind" in project);
    assert.equal(project.kind, "synced");
    assert(context.readSource);
    assert.deepEqual(
      Object.keys(project.files).sort(),
      Object.keys(expected).sort(),
    );
    for (const [path, file] of Object.entries(project.files))
      assert.deepEqual(await context.readSource(file), expected[path]);
  }
  const pdf = new TextEncoder().encode("%PDF-compile-route-test");
  return {
    pdf,
    log: "compiled",
    timing: unknownEngineTiming,
    files: { "main.pdf": new Blob([pdf]) },
  };
};
const compiler = createLocalRuntime({
  path: join(directory, "compiler.sqlite"),
  engine,
  projectEngine: () => engine,
});
let loseResponse = false;
let beforeSubmit = async () => {};
const worker = await build({
  entryPoints: [new URL("./compile-route/worker.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire("file:///worker.js");',
  },
  external: [
    ...builtinModules,
    "node:*",
    "cloudflare:workers",
    "cloudflare:sockets",
    "#tanstack-router-entry",
    "#tanstack-start-entry",
    "tanstack-start-manifest:v",
  ],
  define: { "import.meta.env.DEV": "false" },
});
const script = worker.outputFiles[0]?.text;
assert(script);
// The route, signed-session auth, Postgres, R2, and compiler coordinator run for
// real. Only the TeX engine and a lost service response are fixtures.
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2025-09-02",
    compatibilityFlags: ["nodejs_compat", "enable_nodejs_fs_module"],
    hyperdrives: { HYPERDRIVE: connectionString },
    r2Buckets: ["SOURCES"],
    bindings: {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: "http://localhost",
      STRIPE_SECRET_KEY: "sk_test_compile_fixture",
      GITHUB_CLIENT_ID: "fixture",
      GITHUB_CLIENT_SECRET: "fixture",
      GOOGLE_CLIENT_ID: "fixture",
      GOOGLE_CLIENT_SECRET: "fixture",
      GITLAB_CLIENT_ID: "fixture",
      GITLAB_CLIENT_SECRET: "fixture",
      MICROSOFT_CLIENT_ID: "fixture",
      MICROSOFT_CLIENT_SECRET: "fixture",
    },
    serviceBindings: {
      COMPILER: async (request) => {
        const submitting = request.method === "POST";
        if (submitting) await beforeSubmit();
        const body = submitting ? await request.text() : undefined;
        const response = await compiler.fetch(
          new Request(request.url, {
            method: request.method,
            headers: [...request.headers.entries()],
            body,
          }),
        );
        if (submitting) {
          submissions.push({
            id: request.headers.get("X-Compilation-Id") ?? "",
            body: JSON.parse(body ?? "null"),
            status: response.status,
          });
          if (loseResponse && response.status === 202) {
            loseResponse = false;
            throw new Error("Lost compiler acceptance response");
          }
        }
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      },
    },
  }),
  resourcePersistencePath: directory,
});

async function fixture() {
  const userId = crypto.randomUUID();
  cookies.set(userId, "");
  await db.insert(user).values({
    id: userId,
    name: "Compile test",
    email: `${userId}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const token = crypto.randomUUID();
  await db.insert(session).values({
    id: crypto.randomUUID(),
    token,
    userId,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  cookies.set(
    userId,
    `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  );
  const project = await createProject({
    db,
    ownerId: userId,
    data: { id: crypto.randomUUID(), name: "Compile retries" },
  });
  return { userId, projectId: project.id };
}

const delta = {
  mainFile: "main.tex",
  baseRevision: 0,
  revision: 1,
  files: {
    "main.tex": { hash: await hashSource(new Uint8Array()), content: "" },
  },
  deleted: [],
};

async function submit(options: {
  userId: string;
  projectId: string;
  id: string;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return mf.dispatchFetch(
    `${(await mf.ready).origin}/api/compile/${options.projectId}`,
    {
      method: "POST",
      headers: {
        Cookie: cookies.get(options.userId) ?? "",
        "Content-Type": "application/json",
        "X-Compilation-Id": options.id,
        ...options.headers,
      },
      body: JSON.stringify(options.body ?? delta),
    },
  );
}

async function completed(projectId: string, userId: string, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await mf.dispatchFetch(
      `${(await mf.ready).origin}/api/compile/${projectId}?job=${id}`,
      { headers: { Cookie: cookies.get(userId) ?? "" } },
    );
    assert.equal(response.status, 200);
    const result = z
      .object({ status: z.string() })
      .parse(await response.json());
    if (result.status === "succeeded") return;
    assert.notEqual(result.status, "failed");
    await Bun.sleep(50);
  }
  assert.fail("Compilation never completed");
}

try {
  const original = { ...(await fixture()), id: crypto.randomUUID() };
  const first = await submit(original);
  assert.equal(first.status, 202);
  const statusUrl = first.headers.get("Location");
  // Drop the submission response before the client can read its job details.
  await first.body?.cancel();
  const retry = await submit(original);
  assert.equal(retry.status, 202, await retry.clone().text());
  const repeated = accepted.parse(await retry.json());
  assert.equal(repeated.id, original.id);
  assert.equal(repeated.statusUrl, statusUrl);
  assert.equal(retry.headers.get("Location"), statusUrl);
  assert.equal(submissions.length, 1, "Retry must not submit to the compiler");
  await completed(original.projectId, original.userId, original.id);
  assert.equal(engineCalls, 1);
  assert.equal(
    (await submit(original)).status,
    202,
    "Completed jobs remain retryable",
  );
  assert.equal(submissions.length, 1);

  const job = await db.query.projectJob.findFirst({
    where: { id: original.id },
  });
  assert.equal(job?.status, "succeeded", "GET reconciles the persisted job");
  const conflict = { error: "Compilation ID already used" };
  for (const body of [
    { ...delta, mainFile: "other.tex" },
    { ...delta, baseRevision: 1 },
    { ...delta, revision: 2 },
    { ...delta, deleted: ["removed.tex"] },
    {
      ...delta,
      files: { "main.tex": { ...delta.files["main.tex"], content: "changed" } },
    },
    { ...delta, files: { "main.tex": { hash: "0".repeat(64), content: "" } } },
  ]) {
    const response = await submit({ ...original, body });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), conflict);
  }
  const changedHeaders: Array<Record<string, string>> = [
    { "X-Clean-Build": "1" },
    { "X-Source-Metadata": "changed" },
    { "X-Editor-Id": crypto.randomUUID(), "X-Editor-Sequence": "1" },
  ];
  for (const headers of changedHeaders)
    assert.equal((await submit({ ...original, headers })).status, 409);

  const other = await fixture();
  const collision = await submit({ ...other, id: original.id });
  assert.equal(collision.status, 409);
  assert.deepEqual(await collision.json(), conflict);
  const otherProject = await createProject({
    db,
    ownerId: original.userId,
    data: { id: crypto.randomUUID(), name: "Different project" },
  });
  assert.equal(
    (await submit({ ...original, projectId: otherProject.id })).status,
    409,
  );
  assert.equal(
    (await submit({ ...original, userId: other.userId })).status,
    404,
  );
  await db.insert(projectCollaborator).values({
    projectId: original.projectId,
    userId: other.userId,
    role: "editor",
  });
  const sharedCollision = await submit({ ...original, userId: other.userId });
  assert.equal(sharedCollision.status, 409);
  assert.deepEqual(await sharedCollision.json(), conflict);
  await db
    .delete(projectCollaborator)
    .where(eq(projectCollaborator.userId, other.userId));

  const legacyId = crypto.randomUUID();
  await db
    .insert(projectJob)
    .values({ id: legacyId, projectId: original.projectId, sizeBytes: 0n });
  assert.equal((await submit({ ...original, id: legacyId })).status, 409);
  assert.equal(submissions.length, 1, "Conflicts never reach the compiler");
  assert.deepEqual(
    await db.query.projectJob.findFirst({ where: { id: original.id } }),
    job,
  );

  const lost = { ...(await fixture()), id: crypto.randomUUID() };
  loseResponse = true;
  const uncertain = await submit(lost);
  assert.equal(uncertain.status, 202);
  assert.equal(accepted.parse(await uncertain.json()).revision, undefined);
  const recovered = await submit(lost);
  assert.equal(recovered.status, 202);
  assert.equal(accepted.parse(await recovered.json()).id, lost.id);
  assert.equal(
    submissions.filter((request) => request.id === lost.id).length,
    1,
  );
  await completed(lost.projectId, lost.userId, lost.id);
  assert.equal(
    engineCalls,
    2,
    "Lost acceptance response must not duplicate a build",
  );

  const concurrent = { ...(await fixture()), id: crypto.randomUUID() };
  const submitting = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  beforeSubmit = async () => {
    submitting.resolve();
    await released.promise;
  };
  const leader = submit(concurrent);
  assert.equal(
    await Promise.race([
      submitting.promise.then(() => true),
      leader.then(() => false),
    ]),
    true,
    "Submission never reached compiler",
  );
  const followers = Array.from({ length: 4 }, () => submit(concurrent));
  released.resolve();
  const responses = await Promise.all([leader, ...followers]);
  beforeSubmit = async () => {};
  for (const response of responses) {
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal(accepted.parse(await response.json()).id, concurrent.id);
  }
  assert.equal(
    submissions.filter((request) => request.id === concurrent.id).length,
    1,
  );
  assert.equal(
    (await db.query.projectJob.findMany({ where: { id: concurrent.id } }))
      .length,
    1,
  );
  await completed(concurrent.projectId, concurrent.userId, concurrent.id);
  assert.equal(engineCalls, 3, "Concurrent identical POSTs compile once");

  const resync = { ...(await fixture()), id: crypto.randomUUID() };
  const metadata = await db.transaction((tx) =>
    readProjectMetadata({ tx, ...resync }),
  );
  const headers = {
    "X-Source-Metadata": await projectMetadataVersion(metadata),
  };
  const response = await submit({ ...resync, headers });
  assert.equal(response.status, 202, await response.clone().text());
  const synced = accepted.parse(await response.json());
  assert.equal(synced.sourceRevision, 1);
  const resynced = submissions.filter((request) => request.id === resync.id);
  assert.deepEqual(
    resynced.map((request) => request.status),
    [409, 202],
  );
  assert.deepEqual(
    resynced.map(
      (request) => z.object({ resync: z.boolean() }).parse(request.body).resync,
    ),
    [false, true],
  );
  assert.equal((await submit({ ...resync, headers })).status, 202);
  assert.equal(
    submissions.filter((request) => request.id === resync.id).length,
    2,
  );
  await completed(resync.projectId, resync.userId, resync.id);
  assert.equal(engineCalls, 4);

  const assistant = await fixture();
  await db.insert(subscription).values({
    id: crypto.randomUUID(),
    referenceId: assistant.userId,
    plan: "pro",
    status: "active",
    stripeCustomerId: "cus_compile_assistant",
    stripeSubscriptionId: "sub_compile_assistant",
  });
  const bucket = await mf.getR2Bucket("SOURCES");
  const nodes = await db.query.projectNode.findMany({
    where: { projectId: assistant.projectId },
  });
  const root = nodes.find((node) => node.kind === "folder");
  const main = nodes.find((node) => node.name === "main.tex");
  assert(root && main);
  const sources = {
    "main.tex":
      "\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\end{document}",
    "sections/body.tex": "Saved section content.",
    "image.bin": { base64: "AAH/" },
    "empty.tex": "",
  };
  expectedSources.set(assistant.projectId, sources);
  const sectionId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: sectionId,
    projectId: assistant.projectId,
    parentId: root.id,
    name: "sections",
    kind: "folder",
    sizeBytes: 0n,
  });
  for (const [path, content] of Object.entries(sources)) {
    const bytes =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : Buffer.from(content.base64, "base64");
    const objectKey = `projects/${assistant.projectId}/sources/${await hashSource(bytes)}`;
    await bucket.put(objectKey, bytes);
    if (path === "main.tex")
      await db
        .update(projectNode)
        .set({ objectKey, sizeBytes: BigInt(bytes.length) })
        .where(eq(projectNode.id, main.id));
    else
      await db.insert(projectNode).values({
        projectId: assistant.projectId,
        parentId: path.includes("/") ? sectionId : root.id,
        name: path.split("/").at(-1) ?? path,
        kind: typeof content === "string" ? "text" : "binary",
        objectKey,
        sizeBytes: BigInt(bytes.length),
      });
  }
  const assistantMetadata = await db.transaction((tx) =>
    readProjectMetadata({ tx, ...assistant }),
  );
  const version = await projectMetadataVersion(assistantMetadata);
  async function assistantCompile(
    label: string,
    statuses: number[],
    metadata?: string,
  ) {
    const start = submissions.length;
    const response = await mf.dispatchFetch(
      `${(await mf.ready).origin}/api/compile/${assistant.projectId}?assistant=1`,
      {
        method: "POST",
        headers: {
          Cookie: cookies.get(assistant.userId) ?? "",
          "Content-Type": "application/json",
          ...(metadata ? { "X-Source-Metadata": metadata } : {}),
        },
        body: JSON.stringify({ mainFile: "main.tex" }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const job = accepted.parse(await response.json());
    const attempts = submissions.slice(start);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      statuses,
      label,
    );
    for (const attempt of attempts) {
      const snapshot = sourceDeltaSchema.parse(attempt.body);
      assert.equal(
        snapshot.resync,
        true,
        `${label}: submit saved sources immediately`,
      );
      assert.deepEqual(
        Object.keys(snapshot.files).sort(),
        Object.keys(sources).sort(),
        label,
      );
      for (const [path, content] of Object.entries(sources))
        assert.deepEqual(snapshot.files[path]?.content, content, label);
    }
    await completed(assistant.projectId, assistant.userId, job.id);
  }
  await assistantCompile("first assistant compile", [202]);
  await assistantCompile(
    "later assistant compile with inherited metadata",
    [409, 202],
    version,
  );
  // Clearing the mirror sets sources to null, just like the 30-day source wipe.
  assert.equal(
    (
      await compiler.fetch(
        new Request(`http://local/projects/${assistant.projectId}/build`, {
          method: "DELETE",
        }),
      )
    ).status,
    204,
  );
  await assistantCompile("assistant compile after source wipe", [202], version);
  assert.equal(
    engineCalls,
    7,
    "Each assistant submission reaches the engine with all saved files",
  );

  await db.delete(session).where(eq(session.userId, original.userId));
  assert.equal(
    (await submit(original)).status,
    401,
    "Retry still requires a valid session",
  );
  console.info(
    "Compile route passed: identical and completed retries, payload/header/project/user conflicts, legacy IDs, lost responses, concurrent POSTs, source resync, assistant full snapshots before and after source wipe, and Postgres reconciliation",
  );
} finally {
  for (const id of cookies.keys()) await db.delete(user).where(eq(user.id, id));
  await db.$client.end();
  await mf.dispose();
  compiler.close();
  await rm(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  account,
  project,
  projectCollaborator,
  projectGit,
  projectNode,
  session,
  user,
} from "@texfolia/db/schema";
import { eq, inArray } from "drizzle-orm";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import * as Y from "yjs";
import { z } from "zod";

import {
  collaborationProtocol,
  decodeServerMessage,
  encodeClientMessage,
  protocolSearchParam,
} from "#/lib/collaboration";
import { gitProvider, type GitProvider } from "#/lib/git";
import { GitRepository, gitHttp } from "#/lib/git/server";
import {
  gitCommand,
  gitServer,
  legacyArchive,
  memoryFiles,
} from "#/lib/git/testing";

import { createProject } from "../src/lib/projects/project.server";
import { withBuildsFixture } from "./builds/miniflare";

const connection = process.env.INTEGRATION_DATABASE_URL;
assert(
  connection && new URL(connection).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connection);
const directory = await mkdtemp(join(tmpdir(), "texfolia-git-worker-"));
const host = await gitServer();
const secret = "git-integration-test-secret-not-for-production";
const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const [ownerId, viewerId, editorId] = ids;
assert(ownerId && viewerId && editorId);
let currentProject: string | undefined;
let duringRemote: (() => Promise<void>) | undefined;
const lockedRequests: string[] = [];
const worker = await build({
  entryPoints: [new URL("./git/worker.ts", import.meta.url).pathname],
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
const options = {
  ...withBuildsFixture(
    {
      name: "git-test",
      modules: true,
      script,
      compatibilityDate: "2026-10-31",
      compatibilityFlags: ["nodejs_compat", "enable_nodejs_fs_module"],
      durableObjects: {
        COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
      },
      r2Buckets: ["SOURCES"],
      hyperdrives: { HYPERDRIVE: connection },
      unsafeInspectDurableObjects: true,
      bindings: {
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "http://localhost",
        STRIPE_SECRET_KEY: "sk_test_git",
        GITHUB_CLIENT_ID: "fixture",
        GITHUB_CLIENT_SECRET: "fixture",
        GITLAB_CLIENT_ID: "fixture",
        GITLAB_CLIENT_SECRET: "fixture",
        GOOGLE_CLIENT_ID: "fixture",
        GOOGLE_CLIENT_SECRET: "fixture",
        MICROSOFT_CLIENT_ID: "fixture",
        MICROSOFT_CLIENT_SECRET: "fixture",
      },
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        assert(
          ["github.com", "gitlab.com"].includes(url.hostname),
          `Unexpected outbound request ${url.hostname}`,
        );
        const projectId = currentProject;
        if (projectId)
          await db
            .transaction((tx) =>
              tx
                .select()
                .from(project)
                .where(eq(project.id, projectId))
                .for("update", { noWait: true }),
            )
            .catch(() => lockedRequests.push(url.pathname));
        const hook = duringRemote;
        duringRemote = undefined;
        await hook?.();
        const target = new URL(`${url.pathname}${url.search}`, host.origin);
        return fetch(target, {
          method: request.method,
          headers: request.headers,
          body:
            request.method === "GET" ? undefined : await request.arrayBuffer(),
        });
      },
    },
    () => new Response(null, { status: 204 }),
  ),
  resourcePersistencePath: directory,
};
let mf = new Miniflare(options);
const resultSchema = z.object({
  status: z.object({
    remote: z.object({ provider: z.string(), url: z.string() }).nullable(),
    branch: z.string().nullable(),
    branches: z.array(z.string()),
    changes: z.array(z.object({ path: z.string(), status: z.string() })),
    commits: z.array(z.object({ oid: z.string(), message: z.string() })),
  }),
  diff: z.string().optional(),
});
async function action(projectId: string, action: unknown, userId = ownerId) {
  currentProject = projectId;
  const response = await mf.dispatchFetch(`${(await mf.ready).origin}/git`, {
    method: "POST",
    body: JSON.stringify({ projectId, userId, action }),
  });
  const text = await response.text();
  assert(!text.includes("private-token"), "Tokens never enter git responses");
  if (!response.ok) throw new Error(text);
  return resultSchema.parse(JSON.parse(text));
}
const author = { name: "Remote User", email: "remote@example.com" };
try {
  for (const id of ids)
    await db.insert(user).values({
      id,
      name: "Git author",
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  const localProject = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: `Local git ${crypto.randomUUID()}` },
  });
  assert.equal(
    (await action(localProject.id, { kind: "status" })).status.branch,
    null,
  );
  await assert.rejects(
    action(localProject.id, { kind: "initialize" }),
    /Invalid input|invalid_union|kind/,
    "Texfolia no longer creates remote-free repositories",
  );
  await assert.rejects(
    action(localProject.id, { kind: "commit", message: "No remote" }),
    /Link a repository first/,
  );
  // A repository saved by the removed in-app initialize (NAT-413).
  const legacy = new GitRepository();
  await legacy.init();
  legacy.overlay(memoryFiles({ "main.tex": "hosted history\n" }));
  const localOid = await legacy.commit("Local history before linking", author);
  const legacyKey = `git/${localProject.id}/${crypto.randomUUID()}.json`;
  await (await mf.getR2Bucket("SOURCES")).put(legacyKey, legacyArchive(legacy));
  await db.insert(projectGit).values({
    projectId: localProject.id,
    provider: null,
    url: null,
    objectKey: legacyKey,
    branch: "main",
  });
  const hosted = await action(localProject.id, { kind: "status" });
  assert.equal(hosted.status.remote, null);
  assert.equal(hosted.status.commits[0]?.oid, localOid);
  for (const blocked of [
    { kind: "commit", message: "Still hosted" },
    { kind: "branch", name: "draft" },
    { kind: "push" },
  ])
    await assert.rejects(
      action(localProject.id, blocked),
      /no longer hosts Git repositories/,
    );
  for (const provider of ["github", "gitlab"] satisfies GitProvider[]) {
    const local = await host.create(`owner/${provider}.git`);
    const seed = new GitRepository();
    await seed.init(local);
    seed.overlay(
      memoryFiles({
        "main.tex": "initial\n",
        ".gitignore": "*.aux\n",
        "nested/intro.tex": "intro\n",
        "image.bin": new Uint8Array([0, 255, 1]),
      }),
    );
    await seed.commit("Initial import", author);
    await seed.push(gitHttp(local, "private-token"));
    await db.insert(account).values({
      id: crypto.randomUUID(),
      userId: ownerId,
      accountId: `remote-${provider}`,
      providerId: provider,
      accessToken: "private-token",
      scope: gitProvider(provider).scopes.join(" "),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const created = await createProject({
      db,
      ownerId,
      data: {
        id: crypto.randomUUID(),
        name: `Git ${provider} ${crypto.randomUUID()}`,
      },
    });
    const projectId = created.id;
    await db.insert(projectCollaborator).values([
      { projectId, userId: viewerId, role: "viewer" },
      { projectId, userId: editorId, role: "editor" },
    ]);
    const remote = `https://${provider === "github" ? "github.com" : "gitlab.com"}/owner/${provider}.git`;
    let result = await action(projectId, { kind: "import", remote });
    assert.equal(result.status.commits[0]?.message, "Initial import");
    assert.equal(result.status.remote?.provider, provider);
    assert.equal(
      (await action(projectId, { kind: "status" }, viewerId)).status.branch,
      "main",
    );
    await assert.rejects(
      action(projectId, { kind: "commit", message: "Denied" }, viewerId),
      /Project not found/,
    );
    await assert.rejects(
      action(projectId, { kind: "push" }, editorId),
      /Connect .*repository access/,
    );
    let nodes = await db
      .select()
      .from(projectNode)
      .where(eq(projectNode.projectId, projectId));
    const node = nodes.find((n) => n.name === "main.tex" && !n.deletedAt);
    const binary = nodes.find((n) => n.name === "image.bin" && !n.deletedAt);
    assert(node && binary);
    assert.equal(binary.kind, "binary");
    const bucket = await mf.getR2Bucket("SOURCES");
    assert(binary.objectKey);
    assert.deepEqual(
      new Uint8Array(await (await bucket.get(binary.objectKey))!.arrayBuffer()),
      new Uint8Array([0, 255, 1]),
    );
    const sessionToken = crypto.randomUUID();
    await db.insert(session).values({
      id: crypto.randomUUID(),
      userId: ownerId,
      token: sessionToken,
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const signature = createHmac("sha256", secret)
      .update(sessionToken)
      .digest("base64");
    const socketResponse = await mf.dispatchFetch(
      `${(await mf.ready).origin}/api/collaboration/${projectId}/${node.id}?${protocolSearchParam}=${collaborationProtocol}`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: (await mf.ready).origin,
          Cookie: `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`,
        },
      },
    );
    assert.equal(socketResponse.status, 101);
    const socket = socketResponse.webSocket;
    assert(socket);
    socket.accept();
    const doc = new Y.Doc();
    const sync = new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const frame = decodeServerMessage(event.data);
        if (frame.type === "error") reject(new Error(frame.message));
        if (frame.type === "sync" || frame.type === "update")
          Y.applyUpdate(doc, frame.update);
        if (frame.type === "sync") resolve();
      });
    });
    socket.send(
      encodeClientMessage({
        type: "sync",
        vector: Y.encodeStateVector(doc),
      }),
    );
    await sync;
    const vector = Y.encodeStateVector(doc);
    doc.getText("source").insert(0, "live edit\n");
    socket.send(
      encodeClientMessage({
        type: "update",
        update: Y.encodeStateAsUpdate(doc, vector),
      }),
    );
    // A sync roundtrip orders the preceding edit ahead of the git RPC.
    await new Promise<void>((resolve) => {
      const listener = (event: { data: unknown }) => {
        if (decodeServerMessage(event.data).type === "sync") {
          socket.removeEventListener("message", listener);
          resolve();
        }
      };
      socket.addEventListener("message", listener);
      socket.send(
        encodeClientMessage({
          type: "sync",
          vector: Y.encodeStateVector(doc),
        }),
      );
    });
    result = await action(projectId, {
      kind: "commit",
      message: "Commit live edit",
    });
    assert.equal(result.status.changes.length, 0);
    await action(projectId, { kind: "push" });
    assert.equal(
      await gitCommand(
        "--git-dir",
        join(host.directory, `owner/${provider}.git`),
        "show",
        "main:main.tex",
      ),
      "live edit\ninitial",
    );
    await action(projectId, { kind: "branch", name: "draft" });
    await action(projectId, { kind: "checkout", name: "draft" });
    const peer = new GitRepository();
    await peer.clone(local, gitHttp(local, "private-token"));
    peer.overlay(
      new Map([
        ...peer.files,
        ...memoryFiles({ "main.tex": "remote update\n" }),
      ]),
    );
    await peer.commit("Remote update", author);
    await peer.push(gitHttp(local, "private-token"));
    await action(projectId, { kind: "checkout", name: "main" });
    const beforePull = doc.getText("source").toString();
    // Sends an edit and waits until the room has accepted it.
    const edit = async (change: () => void) => {
      const vector = Y.encodeStateVector(doc);
      change();
      const accepted = new Promise<void>((resolve) => {
        const listener = (event: { data: unknown }) => {
          if (decodeServerMessage(event.data).type !== "update") return;
          socket.removeEventListener("message", listener);
          resolve();
        };
        socket.addEventListener("message", listener);
      });
      socket.send(
        encodeClientMessage({
          type: "update",
          update: Y.encodeStateAsUpdate(doc, vector),
        }),
      );
      await accepted;
    };
    const text = doc.getText("source");
    duringRemote = () =>
      edit(() => {
        text.insert(0, "typed during pull\n");
      });
    await assert.rejects(
      action(projectId, { kind: "pull" }),
      /Commit your changes/,
    );
    assert.equal(
      text.toString(),
      `typed during pull\n${beforePull}`,
      "The room accepts edits during a request to the Git host, and a pull never overwrites them",
    );
    await edit(() => {
      text.delete(0, "typed during pull\n".length);
    });
    await action(projectId, { kind: "pull" });
    assert.equal(
      doc.getText("source").toString(),
      "remote update\n",
      "Pull updates the existing Yjs room",
    );
    nodes = await db
      .select()
      .from(projectNode)
      .where(eq(projectNode.projectId, projectId));
    assert.equal(
      nodes.find((n) => n.name === "main.tex" && !n.deletedAt)?.id,
      node.id,
    );
    await action(projectId, { kind: "checkout", name: "draft" });
    assert.equal(
      doc.getText("source").toString(),
      "live edit\ninitial\n",
      "Checkout updates the same live room",
    );
    socket.close();
    doc.destroy();
    await mf.dispose();
    mf = new Miniflare(options);
    assert.equal(
      (await action(projectId, { kind: "status" })).status.branch,
      "draft",
      "Git state survives Worker restart",
    );
    await assert.rejects(
      action(projectId, { kind: "unlink" }, editorId),
      /Only the project owner/,
    );
    await action(projectId, { kind: "unlink" });
    assert.equal(
      (await action(projectId, { kind: "status" })).status.remote,
      null,
    );
    assert.equal(
      (
        await db
          .select()
          .from(projectGit)
          .where(eq(projectGit.projectId, projectId))
      ).length,
      0,
    );
    const source = await db
      .select()
      .from(projectNode)
      .where(eq(projectNode.id, node.id));
    assert(source[0]?.objectKey);
    const restartedBucket = await mf.getR2Bucket("SOURCES");
    assert.equal(
      await (await restartedBucket.get(source[0].objectKey))?.text(),
      "live edit\ninitial\n",
      "Unlink retains files",
    );
    await restartedBucket.put(`history/${projectId}/old.yjs`, "old snapshot");
    const collected = await mf.dispatchFetch(
      `${(await mf.ready).origin}/collect`,
    );
    assert.equal(collected.status, 200, await collected.text());
    assert.equal(
      (await restartedBucket.list({ prefix: `git/${projectId}/` })).objects
        .length,
      0,
    );
    assert.equal(
      (await restartedBucket.list({ prefix: `history/${projectId}/` })).objects
        .length,
      0,
    );
  }
  console.log(
    "Git Worker integration passed for GitHub and GitLab: private import, author credentials, viewer denial, live edit commit/push, pull, branch checkout, stable IDs, restart, unlink, and storage cleanup.",
  );
  await host.create("owner/local-history.git");
  const attached = await action(localProject.id, {
    kind: "link",
    remote: "https://github.com/owner/local-history.git",
  });
  assert.equal(attached.status.commits[0]?.oid, localOid);
  await action(localProject.id, { kind: "push" });
  assert.equal(
    await gitCommand(
      "--git-dir",
      join(host.directory, "owner/local-history.git"),
      "rev-parse",
      "main",
    ),
    localOid,
  );
  const large = await host.create("owner/large.git");
  const largeSeed = new GitRepository();
  await largeSeed.init(large);
  largeSeed.overlay(
    memoryFiles(
      Object.fromEntries(
        Array.from({ length: 800 }, (_, i) => [
          `chapters/${i % 20}/${i}.tex`,
          `File ${i}\n`,
        ]),
      ),
    ),
  );
  await largeSeed.commit("Many files", author);
  await largeSeed.push(gitHttp(large, "private-token"));
  const largeProject = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: `Large ${crypto.randomUUID()}` },
  });
  const liveNodes = async () =>
    (
      await db
        .select()
        .from(projectNode)
        .where(eq(projectNode.projectId, largeProject.id))
    ).filter((node) => !node.deletedAt);
  await action(largeProject.id, {
    kind: "import",
    remote: "https://github.com/owner/large.git",
  });
  const imported = await liveNodes();
  assert.equal(imported.length, 1 + 21 + 800);
  largeSeed.overlay(
    new Map([
      ...largeSeed.files,
      ...memoryFiles({ "chapters/3/3.tex": "Changed\n" }),
    ]),
  );
  await largeSeed.commit("Change one", author);
  await largeSeed.push(gitHttp(large, "private-token"));
  const pullResult = await action(largeProject.id, { kind: "pull" });
  assert.deepEqual(pullResult.status.changes, []);
  const before = new Map(imported.map((node) => [node.id, node]));
  const pulled = await liveNodes();
  assert.equal(pulled.length, imported.length);
  assert.deepEqual(
    pulled
      .filter(
        (node) =>
          before.get(node.id)?.updatedAt.getTime() !== node.updatedAt.getTime(),
      )
      .map((node) => node.name),
    ["3.tex"],
    "Pull writes only the file that changed",
  );
  const changedNode = pulled.find((node) => node.name === "3.tex");
  assert(changedNode?.objectKey);
  assert.equal(
    await (
      await (await mf.getR2Bucket("SOURCES")).get(changedNode.objectKey)
    )?.text(),
    "Changed\n",
  );
  console.info("An 800-file import, and a pull that writes one file, passed");
  assert.deepEqual(
    lockedRequests,
    [],
    "No Git host request runs while the project row is locked",
  );
  console.info(
    "No-repository status, rejected initialize, read-only legacy hosted history, and its empty-remote link/push passed",
  );
} finally {
  await mf.dispose();
  await host.close();
  await db.delete(user).where(inArray(user.id, ids));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}

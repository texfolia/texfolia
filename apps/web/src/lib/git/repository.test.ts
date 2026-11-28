import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import * as git from "isomorphic-git";

import { GitRepository, gitHttp } from "./repository";
import { gitBranchSchema, gitRemoteSchema } from "./schema";
import {
  archiveBody,
  gitCommand as command,
  gitServer,
  memoryFiles,
  readText,
  repositoryArchive,
} from "./testing";

const author = { name: "Git Test", email: "git@example.com" };
const reload = async (repo: GitRepository) =>
  GitRepository.restore(archiveBody(await repositoryArchive(repo)));
let directory: string;
let remote: string;
let server: Awaited<ReturnType<typeof gitServer>>;
beforeAll(async () => {
  server = await gitServer();
  directory = server.directory;
  remote = await server.create("repo.git");
  await server.create("empty.git");
  const seed = new GitRepository();
  await seed.init(remote);
  seed.overlay(
    memoryFiles({
      "main.tex": "initial\n",
      ".gitignore": "ignored/\n*.aux\n!keep.aux\n",
      "image.bin": new Uint8Array([0, 255, 1]),
    }),
  );
  await seed.commit("Initial", author);
  await seed.push(gitHttp(remote, "private-token"));
});
afterAll(async () => {
  await server?.close();
});

describe("repository URLs and branches", () => {
  test("restricts git hosts and forbids embedded credentials", () => {
    for (const url of [
      "http://github.com/a/b",
      "https://evil.com/a/b",
      "https://token@github.com/a/b",
      "https://gitlab.local/a/b",
      "https://github.com/a/b?x=1",
      "https://github.com:8443/a/b",
    ])
      expect(gitRemoteSchema.safeParse(url).success).toBe(false);
    expect(gitRemoteSchema.parse("https://github.com/a/b")).toEqual({
      provider: "github",
      url: "https://github.com/a/b.git",
    });
    expect(
      gitRemoteSchema.parse("https://gitlab.com/a/subgroup/b.git").provider,
    ).toBe("gitlab");
    for (const branch of [
      "../main",
      "refs//bad",
      "main.lock",
      "-bad",
      "a b",
      "a@{b",
      ".hidden",
    ])
      expect(gitBranchSchema.safeParse(branch).success).toBe(false);
  });
});

test("private import, ignore rules, real commits, persistence, push/pull, branches, and binary files", async () => {
  const http = gitHttp(remote, "private-token");
  const repo = new GitRepository();
  await repo.clone(remote, http);
  expect(server.requests.some((r) => r.authorization)).toBe(true);
  expect(await repo.files.get("image.bin")?.read()).toEqual(
    Buffer.from([0, 255, 1]),
  );
  repo.overlay(
    new Map([
      ...repo.files,
      ...memoryFiles({
        "main.tex": "edited\n",
        "ignored/file.tex": "not committed",
        "temp.aux": "not committed",
        "keep.aux": "keep me",
      }),
    ]),
  );
  expect((await repo.status()).changes.map((c) => c.path)).toEqual([
    "keep.aux",
    "main.tex",
  ]);
  await expect(repo.commit("  ", author)).rejects.toThrow("message");
  await expect(repo.checkout("main", http)).rejects.toThrow(
    "Commit your changes",
  );
  await repo.commit("Edit main", author);
  const restored = await reload(repo);
  restored.overlay(repo.files);
  expect((await restored.status()).changes).toHaveLength(0);
  await restored.push(http);
  const clone = new GitRepository();
  await clone.clone(remote, http);
  expect(await readText(clone, "main.tex")).toBe("edited\n");
  expect(clone.files.has("ignored/file.tex")).toBe(false);
  expect(clone.files.has("keep.aux")).toBe(true);
  await restored.branch("draft");
  await restored.checkout("draft", http);
  expect(await readText(restored, "ignored/file.tex")).toBe("not committed");
  restored.overlay(
    new Map([...restored.files, ...memoryFiles({ "main.tex": "draft\n" })]),
  );
  await restored.commit("Draft branch", author);
  await restored.push(http);
  await clone.remoteBranches(http, remote);
  expect((await clone.status()).branches).toContain("draft");
  await clone.checkout("draft", http);
  expect(await readText(clone, "main.tex")).toBe("draft\n");
  await clone.checkout("main", http);
  expect(await readText(clone, "main.tex")).toBe("edited\n");
  restored.overlay(
    new Map([
      ...restored.files,
      ...memoryFiles({ "main.tex": "updated draft\n" }),
    ]),
  );
  await restored.commit("Update draft", author);
  await restored.push(http);
  await clone.checkout("draft", http);
  await clone.pull(http, author);
  expect(await readText(clone, "main.tex")).toBe("updated draft\n");
  expect((await clone.status()).commits[0]?.message).toBe("Update draft");
  await clone.checkout("main", http);
  clone.overlay(
    new Map([...clone.files].filter(([path]) => path !== "image.bin")),
  );
  expect(await clone.diff()).toContain("image.bin");
  await clone.commit("Remove image", author);
  await clone.push(http);
  const bare = ["--git-dir", join(directory, "repo.git")];
  expect(await command(...bare, "log", "-1", "--format=%s", "main")).toBe(
    "Remove image",
  );
  expect(
    (await command(...bare, "ls-tree", "-r", "--name-only", "main")).split(
      "\n",
    ),
  ).not.toContain("image.bin");
  await command(...bare, "fsck", "--strict");
}, 30_000);

test("link requires an empty remote; conflicting pull leaves working files unchanged", async () => {
  const repo = new GitRepository();
  await expect(
    repo.requireEmptyRemote(remote, gitHttp(remote, "private-token")),
  ).rejects.toThrow("empty repository");
  const emptyUrl = `${server.origin}/empty.git`;
  await repo.requireEmptyRemote(emptyUrl, gitHttp(emptyUrl, "private-token"));
  repo.overlay(memoryFiles({ "main.tex": "seed\n" }));
  await repo.commit("Seed", author);
  await repo.push(gitHttp(emptyUrl, "private-token"));
  const peer = new GitRepository();
  await peer.clone(emptyUrl, gitHttp(emptyUrl, "private-token"));
  repo.overlay(memoryFiles({ "main.tex": "ours\n" }));
  await repo.commit("Ours", author);
  peer.overlay(memoryFiles({ "main.tex": "theirs\n" }));
  await peer.commit("Theirs", author);
  await peer.push(gitHttp(emptyUrl, "private-token"));
  await expect(
    repo.pull(gitHttp(emptyUrl, "private-token"), author),
  ).rejects.toBeInstanceOf(git.Errors.MergeConflictError);
  expect(await readText(repo, "main.tex")).toBe("ours\n");
  expect((await repo.status()).changes).toHaveLength(0);
  await expect(
    repo.push(gitHttp(emptyUrl, "private-token")),
  ).rejects.toBeInstanceOf(git.Errors.PushRejectedError);
}, 30_000);

// Commits a worktree with the real Git, pushes it, and imports it.
async function importing(
  name: string,
  files: Record<string, string>,
  prepare: (directory: string) => Promise<unknown> = async () => {},
) {
  const url = await server.create(`${name}.git`);
  const work = await mkdtemp(join(directory, `${name}-`));
  const run = (...args: string[]) => command("-C", work, ...args);
  await run("init", "--initial-branch=main");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, dirname(path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await prepare(work);
  await run("add", "--all", "--force");
  await run(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "Fixture",
  );
  await run("push", join(directory, `${name}.git`), "main");
  const repo = new GitRepository();
  await repo.clone(url, gitHttp(url, "private-token"));
  return { repo, url, run, work };
}

test("rejects unrepresentable imports and preserves nested ignore rules", async () => {
  const repo = new GitRepository();
  await repo.init("https://gitlab.com/owner/repository.git");
  repo.overlay(
    memoryFiles({
      "main.tex": "body",
      "chapters/.gitignore": "*.tmp\n!keep.tmp\n",
      "chapters/drop.tmp": "ignore",
      "chapters/keep.tmp": "keep",
    }),
  );
  const changes = (await repo.status()).changes.map((c) => c.path);
  expect(changes).not.toContain("chapters/drop.tmp");
  expect(changes).toContain("chapters/keep.tmp");
  expect(() => repo.overlay(memoryFiles({ ".git/config": "no" }))).toThrow(
    "reserved",
  );
  expect(() => repo.overlay(memoryFiles({ "a/.GIT/x": "no" }))).toThrow(
    "reserved",
  );
  await expect(
    importing("collide", { "main.tex": "a", "MAIN.tex": "b" }),
  ).rejects.toThrow("case-colliding");
  await expect(
    importing("folders", { "a/one.tex": "a", "A/two.tex": "b" }),
  ).rejects.toThrow("case-colliding");
  await expect(
    importing("mixed", { "a/one.tex": "a", A: "b" }),
  ).rejects.toThrow("case-colliding");
  await expect(
    importing("symlink", { "main.tex": "a" }, (work) =>
      symlink("/etc/passwd", join(work, "link")),
    ),
  ).rejects.toThrow("Symbolic links");
  await expect(
    importing("modules", { "main.tex": "a", ".gitmodules": "" }),
  ).rejects.toThrow("Submodules");
  await expect(
    importing(
      "many",
      Object.fromEntries(
        Array.from({ length: 1001 }, (_, i) => [`${i}.tex`, ""]),
      ),
    ),
  ).rejects.toThrow("1,000");
}, 60_000);

test("commits keep file modes, out/ and unchanged folders", async () => {
  const { repo, url, run, work } = await importing(
    "modes",
    {
      "main.tex": "main\n",
      "build.sh": "#!/bin/sh\n",
      "out/kept.pdf": "pdf",
      "a/b/deep.tex": "deep\n",
      "c/only.tex": "only\n",
    },
    (work) => chmod(join(work, "build.sh"), 0o755),
  );
  expect(repo.files.has("out/kept.pdf")).toBe(false);
  expect((await repo.status()).changes).toEqual([]);
  const files = new Map([
    ...repo.files,
    ...memoryFiles({ "build.sh": "#!/bin/bash\n", "a/new.tex": "new\n" }),
  ]);
  files.delete("c/only.tex");
  repo.overlay(files);
  await repo.commit("Change", author);
  await repo.push(gitHttp(url, "private-token"));
  await run("pull", join(directory, "modes.git"), "main");
  expect((await run("ls-files", "-s", "build.sh")).startsWith("100755")).toBe(
    true,
  );
  expect((await run("ls-files")).split("\n")).toEqual([
    "a/b/deep.tex",
    "a/new.tex",
    "build.sh",
    "main.tex",
    "out/kept.pdf",
  ]);
  expect(await run("status", "--porcelain")).toBe("");
  expect(await readFile(join(work, "build.sh"), "utf8")).toBe("#!/bin/bash\n");
}, 30_000);

test("an ignored file blocks a checkout that tracks different content there", async () => {
  const { repo } = await importing("ignored", { ".gitignore": "*.aux\n" });
  await repo.branch("tracked");
  const base = new Map([...repo.files, ...memoryFiles({ "main.aux": "mine" })]);
  repo.overlay(base);
  expect((await repo.status()).changes).toEqual([]);
  await repo.switchBranch("tracked");
  repo.overlay(memoryFiles({ ".gitignore": "", "main.aux": "theirs" }));
  await repo.commit("Track it", author);
  repo.overlay(repo.files);
  await repo.switchBranch("main");
  repo.overlay(base);
  await expect(repo.switchBranch("tracked")).rejects.toThrow("main.aux");
}, 30_000);

test("reads only the files whose Git blob is unknown", async () => {
  const { repo } = await importing("lazy", {
    "main.tex": "main\n",
    "a.tex": "a\n",
  });
  const reads: string[] = [];
  const counted = (known: boolean) =>
    new Map(
      [...repo.files].map(([path, file]) => [
        path,
        {
          oid: known ? file.oid : undefined,
          read: () => {
            reads.push(path);
            return file.read();
          },
        },
      ]),
    );
  const first = counted(true);
  repo.overlay(first);
  expect((await repo.status()).changes).toEqual([]);
  expect(reads).toEqual([]);
  first.delete("a.tex");
  for (const [path, file] of memoryFiles({ "b.tex": "b\n" }))
    first.set(path, file as never);
  repo.overlay(first);
  expect((await repo.status()).changes).toEqual([
    { path: "a.tex", status: "deleted" },
    { path: "b.tex", status: "added" },
  ]);
  expect(reads).toEqual([]);
}, 30_000);

test("leaves out remote branches that cannot be checked out", async () => {
  const { repo, url } = await importing("names", { "main.tex": "main\n" });
  const oid = (await repo.status()).commits[0]?.oid ?? "";
  const bare = ["--git-dir", join(directory, "names.git")];
  for (const name of ["good/one", "HEAD", "semi;colon"])
    await command(...bare, "update-ref", `refs/heads/${name}`, oid);
  await command(...bare, "update-ref", "refs/heads/-dash", oid);
  await command(...bare, "update-ref", `refs/heads/${"x".repeat(201)}`, oid);
  await repo.remoteBranches(gitHttp(url, "private-token"), url);
  expect((await repo.status()).branches).toEqual([
    "good/one",
    "main",
    "semi;colon",
  ]);
}, 30_000);

test("refuses a push over 20 MiB before building or sending its pack", async () => {
  const { repo, url } = await importing("large", { "main.tex": "main\n" });
  const http = gitHttp(url, "private-token");
  // Random files do not compress. Each is stored once, so 18 MiB fits the clone.
  const random = () => {
    const bytes = new Uint8Array(6 * 1024 * 1024);
    for (let at = 0; at < bytes.length; at += 65_536)
      crypto.getRandomValues(bytes.subarray(at, at + 65_536));
    return bytes;
  };
  const big = memoryFiles({ "1.bin": random(), "2.bin": random() });
  repo.overlay(new Map([...repo.files, ...big]));
  await repo.commit("Within the limit", author);
  await repo.push(http);
  expect(
    await command(
      "--git-dir",
      join(directory, "large.git"),
      "log",
      "-1",
      "--format=%s",
      "main",
    ),
  ).toBe("Within the limit");
  repo.overlay(
    new Map([
      ...repo.files,
      ...memoryFiles({ "3.bin": random(), "4.bin": random() }),
    ]),
  );
  await expect(repo.commit("Too much history", author)).rejects.toThrow(
    "Git history exceeds 20 MiB",
  );
  const before = server.requests.length;
  await expect(
    gitHttp(url, "private-token").request({
      url: `${url}/git-receive-pack`,
      method: "POST",
      body: (async function* () {
        for (let i = 0; i < 4; i++) yield random();
      })(),
    }),
  ).rejects.toThrow("Push exceeds 20 MiB");
  expect(server.requests.length).toBe(before);
}, 60_000);

test("refuses to unpack shared deltas into a push over 20 MiB", async () => {
  // 40 revisions of one incompressible file delta to about one copy of it.
  const { repo, url, run, work } = await importing("delta", { "a.tex": "a" });
  const file = new Uint8Array(1024 * 1024);
  for (let at = 0; at < file.length; at += 65_536)
    crypto.getRandomValues(file.subarray(at, at + 65_536));
  for (let revision = 0; revision < 40; revision++) {
    file[revision] = (file[revision] ?? 0) ^ 1;
    await writeFile(join(work, "big.bin"), file);
    await run("add", "--all");
    await run(
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      `${revision}`,
    );
  }
  await run("push", join(directory, "delta.git"), "main");
  const http = gitHttp(url, "private-token");
  await repo.pull(http, author);
  expect(
    repo.metadata().reduce((total, [, value]) => total + value.byteLength, 0),
  ).toBeLessThan(4 * 1024 * 1024);
  // The host loses everything, so a push would send each revision in full.
  await rm(join(directory, "delta.git"), { recursive: true });
  await server.create("delta.git");
  const before = server.requests.length;
  await expect(repo.push(http)).rejects.toThrow("Push exceeds 20 MiB");
  expect(server.requests.slice(before).map(({ path }) => path)).not.toContain(
    "/delta.git/git-receive-pack",
  );
}, 60_000);

test("restores archives and rejects invalid ones", async () => {
  const repo = new GitRepository();
  await repo.init(remote);
  repo.overlay(memoryFiles({ "main.tex": "saved\n" }));
  const oid = await repo.commit("Saved", author);
  const restored = await reload(repo);
  restored.overlay(memoryFiles({ "main.tex": "saved\n" }));
  const status = await restored.status();
  expect(status.commits[0]?.oid).toBe(oid);
  expect(status.changes).toEqual([]);
  const archive = await repositoryArchive(repo);
  for (const invalid of [
    archive.slice(0, -1),
    archive.slice(1),
    new Uint8Array(),
  ])
    await expect(GitRepository.restore(archiveBody(invalid))).rejects.toThrow(
      "Invalid repository data",
    );
});

test("a repository can commit and restore without a remote, then attach and push its history", async () => {
  const repo = new GitRepository();
  await repo.init();
  repo.overlay(memoryFiles({ "main.tex": "local history\n" }));
  expect((await repo.status()).branch).toBe("main");
  const oid = await repo.commit("Before a remote", author);
  const restored = await reload(repo);
  restored.overlay(repo.files);
  expect((await restored.status()).commits[0]?.oid).toBe(oid);
  const url = await server.create("later.git");
  await restored.requireEmptyRemote(url, gitHttp(url, "private-token"));
  expect((await restored.status()).commits[0]?.oid).toBe(oid);
  await restored.push(gitHttp(url, "private-token"));
  const bare = ["--git-dir", join(directory, "later.git")];
  expect(await command(...bare, "rev-parse", "main")).toBe(oid);
  expect(await command(...bare, "show", "main:main.tex")).toBe("local history");
}, 30_000);

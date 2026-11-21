import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import * as git from "isomorphic-git";

import { gitCommand as command, gitServer } from "../../test/git/http-server";
import { gitBranchSchema, gitRemoteSchema } from "./git";
import { GitRepository, gitHttp } from "./git-repository.server";

const author = { name: "Git Test", email: "git@example.com" };
const bytes = (value: string) => new TextEncoder().encode(value);
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
  seed.overlay({
    "main.tex": bytes("initial\n"),
    ".gitignore": bytes("ignored/\n*.aux\n!keep.aux\n"),
    "image.bin": new Uint8Array([0, 255, 1]),
  });
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
  expect(repo.sources()["image.bin"]).toEqual(new Uint8Array([0, 255, 1]));
  const files = repo.sources();
  repo.overlay({
    ...files,
    "main.tex": bytes("edited\n"),
    "ignored/file.tex": bytes("not committed"),
    "temp.aux": bytes("not committed"),
    "keep.aux": bytes("keep me"),
  });
  repo.write("out/output.pdf", bytes("generated"));
  expect((await repo.status()).changes.map((c) => c.path).sort()).toEqual([
    "keep.aux",
    "main.tex",
  ]);
  await expect(repo.commit("  ", author)).rejects.toThrow("message");
  await expect(repo.checkout("main", http)).rejects.toThrow(
    "Commit your changes",
  );
  await repo.commit("Edit main", author);
  const restored = GitRepository.restore(repo.serialize());
  restored.overlay(repo.sources());
  expect((await restored.status()).changes).toHaveLength(0);
  await restored.push(http);
  const clone = new GitRepository();
  await clone.clone(remote, http);
  expect(new TextDecoder().decode(clone.sources()["main.tex"])).toBe(
    "edited\n",
  );
  expect(clone.sources()["ignored/file.tex"]).toBeUndefined();
  expect(clone.sources()["keep.aux"]).toBeDefined();
  await restored.branch("draft");
  await restored.checkout("draft", http);
  restored.overlay({ ...restored.sources(), "main.tex": bytes("draft\n") });
  await restored.commit("Draft branch", author);
  await restored.push(http);
  await clone.remoteBranches(http, remote);
  expect((await clone.status()).branches).toContain("draft");
  await clone.checkout("draft", http);
  expect(new TextDecoder().decode(clone.sources()["main.tex"])).toBe("draft\n");
  await clone.checkout("main", http);
  expect(new TextDecoder().decode(clone.sources()["main.tex"])).toBe(
    "edited\n",
  );
  restored.overlay({
    ...restored.sources(),
    "main.tex": bytes("updated draft\n"),
  });
  await restored.commit("Update draft", author);
  await restored.push(http);
  await clone.checkout("draft", http);
  await clone.pull(http, author);
  expect(new TextDecoder().decode(clone.sources()["main.tex"])).toBe(
    "updated draft\n",
  );
  expect((await clone.status()).commits[0]?.message).toBe("Update draft");
  await clone.checkout("main", http);
  clone.overlay(
    Object.fromEntries(
      Object.entries(clone.sources()).filter(([path]) => path !== "image.bin"),
    ),
  );
  expect(await clone.diff()).toContain("image.bin");
  await clone.commit("Remove image", author);
  await clone.push(http);
  expect(
    await command(
      "--git-dir",
      join(directory, "repo.git"),
      "log",
      "-1",
      "--format=%s",
      "main",
    ),
  ).toBe("Remove image");
  expect(
    (
      await command(
        "--git-dir",
        join(directory, "repo.git"),
        "ls-tree",
        "-r",
        "--name-only",
        "main",
      )
    ).split("\n"),
  ).not.toContain("image.bin");
}, 30_000);

test("link requires an empty remote; conflicting pull leaves working files unchanged", async () => {
  const repo = new GitRepository();
  await expect(
    repo.requireEmptyRemote(remote, gitHttp(remote, "private-token")),
  ).rejects.toThrow("empty repository");
  const emptyUrl = `${server.origin}/empty.git`;
  await repo.requireEmptyRemote(emptyUrl, gitHttp(emptyUrl, "private-token"));
  repo.overlay({ "main.tex": bytes("seed\n") });
  await repo.commit("Seed", author);
  await repo.push(gitHttp(emptyUrl, "private-token"));
  const peer = new GitRepository();
  await peer.clone(emptyUrl, gitHttp(emptyUrl, "private-token"));
  repo.overlay({ "main.tex": bytes("ours\n") });
  await repo.commit("Ours", author);
  peer.overlay({ "main.tex": bytes("theirs\n") });
  await peer.commit("Theirs", author);
  await peer.push(gitHttp(emptyUrl, "private-token"));
  await expect(
    repo.pull(gitHttp(emptyUrl, "private-token"), author),
  ).rejects.toBeInstanceOf(git.Errors.MergeConflictError);
  expect(new TextDecoder().decode(repo.sources()["main.tex"])).toBe("ours\n");
  expect((await repo.status()).changes).toHaveLength(0);
  await expect(
    repo.push(gitHttp(emptyUrl, "private-token")),
  ).rejects.toBeInstanceOf(git.Errors.PushRejectedError);
}, 30_000);

test("rejects unrepresentable imports and preserves nested ignore rules", async () => {
  const repo = new GitRepository();
  await repo.init("https://gitlab.com/owner/repository.git");
  repo.overlay({
    "main.tex": bytes("body"),
    "chapters/.gitignore": bytes("*.tmp\n!keep.tmp\n"),
    "chapters/drop.tmp": bytes("ignore"),
    "chapters/keep.tmp": bytes("keep"),
  });
  expect((await repo.status()).changes.map((c) => c.path)).not.toContain(
    "chapters/drop.tmp",
  );
  expect((await repo.status()).changes.map((c) => c.path)).toContain(
    "chapters/keep.tmp",
  );
  repo.write("MAIN.tex", bytes("collision"));
  expect(() => repo.sources()).toThrow("case-colliding");
  repo.fs.unlinkSync("/repo/MAIN.tex");
  repo.fs.symlinkSync("/etc/passwd", "/repo/symlink");
  expect(() => repo.sources()).toThrow("Symbolic links");
  repo.fs.unlinkSync("/repo/symlink");
  repo.write(".gitmodules", bytes("submodule"));
  expect(() => repo.sources()).toThrow("Submodules");
  expect(() => repo.overlay({ ".git/config": bytes("overwrite") })).toThrow(
    "reserved",
  );
});

test("a repository can commit and restore without a remote, then attach and push its history", async () => {
  const repo = new GitRepository();
  await repo.init();
  repo.overlay({ "main.tex": bytes("local history\n") });
  repo.write("out/main.aux", bytes("ignored"));
  expect((await repo.status()).branch).toBe("main");
  const oid = await repo.commit("Before a remote", author);
  const restored = GitRepository.restore(repo.serialize());
  restored.overlay(repo.sources());
  expect((await restored.status()).commits[0]?.oid).toBe(oid);
  const url = await server.create("later.git");
  await restored.requireEmptyRemote(url, gitHttp(url, "private-token"));
  expect((await restored.status()).commits[0]?.oid).toBe(oid);
  await restored.push(gitHttp(url, "private-token"));
  expect(
    await command(
      "--git-dir",
      join(directory, "later.git"),
      "rev-parse",
      "main",
    ),
  ).toBe(oid);
  expect(
    await command(
      "--git-dir",
      join(directory, "later.git"),
      "show",
      "main:main.tex",
    ),
  ).toBe("local history");
}, 30_000);

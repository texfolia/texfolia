import { sourcePathSchema } from "@texfolia/contracts";
import { createPatch } from "diff";
import * as git from "isomorphic-git";
import { z } from "zod";

import { mapLimit } from "#/lib/map-limit";

import { readArchive } from "./archive";
import { GitFs } from "./git-fs";
import { gitBranchSchema, type GitStatus } from "./schema";

const maxRepositoryBytes = 20 * 1024 * 1024;
const transferMessage =
  "Git transfer exceeds 20 MiB. Use a smaller repository.";
const pushMessage =
  "Push exceeds 20 MiB. Push this branch from a local clone instead.";
const maxIgnoreBytes = 1024 * 1024;
const maxDiffFileBytes = 128 * 1024;
// Trees can name one subtree many times, so a small pack can hold a huge tree.
const maxTreeEntries = 20_000;
// Maps each stored source to the Git blob with the same content.
const blobCache = "texfolia-blobs";
const blobCacheSchema = z.record(z.string(), z.string());

/** A file in the working tree. Its content is read only when needed. */
export type GitFile = {
  /** The Git blob with this content, when known. */
  oid?: string;
  /** Bounds how many files are read at once. */
  sizeBytes?: number;
  read: () => Promise<Uint8Array<ArrayBuffer>>;
};

type TreeEntry = { oid: string; mode: string; type: string };
type HeadTree = {
  files: Map<string, TreeEntry>;
  /** The tree of every folder, the root's under "". */
  folders: Map<string, string>;
};

// The pack plus the ref update around it.
const maxPushBytes = maxRepositoryBytes + 64 * 1024;

export function gitHttp(
  url: string,
  token: string,
  username = "oauth2",
): git.HttpClient {
  return {
    async request(request) {
      const target = new URL(request.url);
      const remote = new URL(url);
      if (
        target.origin !== remote.origin ||
        !target.pathname.startsWith(`${remote.pathname}/`) ||
        target.username ||
        target.password
      )
        throw new Error("Unexpected git server URL");
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let sent = 0;
      if (request.body)
        for await (const part of request.body) {
          sent += part.byteLength;
          if (sent > maxPushBytes) throw new Error(pushMessage);
          parts.push(part as Uint8Array<ArrayBuffer>);
        }
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Basic ${btoa(`${username}:${token}`)}`);
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: parts.length ? new Blob(parts) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Repository access denied. Reconnect your git account and check repository permissions."
            : "Git server request failed. Check the repository URL and try again.",
        );
      const reader = response.body?.getReader();
      async function* body() {
        let bytes = 0;
        if (!reader) return;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > maxRepositoryBytes) throw new Error(transferMessage);
            yield next.value;
          }
        } finally {
          await reader.cancel();
        }
      }
      return {
        url: response.url,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: body(),
      };
    },
  };
}

function isGenerated(path: string) {
  return path.split("/")[0]?.toLowerCase() === "out";
}

async function hashFile(file: GitFile) {
  return (await git.hashBlob({ object: await file.read() })).oid;
}

/** Every folder that contains `path`, from the root, "". */
function parentFolders(path: string) {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

// A working clone of the linked remote. The remote is the source of truth; this
// copy only carries branches and commits not yet pushed (NAT-413). It has no
// index: a commit's tree is HEAD's with the changed files replaced, and the
// project's files stay in R2 until one of them is needed.
export class GitRepository {
  readonly fs = new GitFs(
    maxRepositoryBytes + maxIgnoreBytes,
    () => new Error("Git history exceeds 20 MiB. Use a smaller repository."),
  );
  // isomorphic-git locks by path across every repository in the isolate, and one
  // Durable Object cannot wait for another's lock.
  readonly dir = `/${crypto.randomUUID()}`;
  private readonly gitdir = `${this.dir}/.git`;
  // Keeps parsed pack indexes between calls.
  private readonly cache = {};
  private worktree = new Map<string, GitFile>();
  private ignoreFiles: string[] = [];
  private loadedHead: { oid: string; tree: HeadTree } | undefined;
  private args() {
    return {
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      cache: this.cache,
    };
  }

  private addMetadata(path: string, value: Uint8Array<ArrayBuffer>) {
    if (path.split("/").some((part) => part === ".." || part === "." || !part))
      throw new Error("Invalid repository data");
    // Clones saved before the index went unused still carry one.
    if (path !== "index") this.fs.add(`${this.gitdir}/${path}`, value);
  }
  static async restore(body: ReadableStream<Uint8Array>) {
    const repo = new GitRepository();
    for await (const [path, value] of readArchive(body, maxRepositoryBytes))
      repo.addMetadata(path, value);
    return repo;
  }
  /** The files to store, checked against the size limit. */
  metadata() {
    const files = [...this.fs.list(this.gitdir)].filter(
      ([path]) => path !== "index",
    );
    if (
      files.reduce((total, [, value]) => total + value.byteLength, 0) >
      maxRepositoryBytes
    )
      throw new Error("Git history exceeds 20 MiB. Use a smaller repository.");
    return files;
  }
  /** Blobs by the stored source with the same content, from the last save. */
  async sourceBlobs() {
    const path = `${this.gitdir}/${blobCache}`;
    if (!this.fs.has(path)) return new Map<string, string>();
    const text = await this.fs.promises.readFile(path, "utf8");
    return new Map(
      Object.entries(blobCacheSchema.parse(JSON.parse(String(text)))),
    );
  }
  saveSourceBlobs(blobs: Map<string, string>) {
    this.fs.add(
      `${this.gitdir}/${blobCache}`,
      JSON.stringify(Object.fromEntries(blobs)),
    );
  }

  /** The working tree: the project's files, or HEAD's after a checkout. */
  get files(): ReadonlyMap<string, GitFile> {
    return this.worktree;
  }
  overlay(files: ReadonlyMap<string, GitFile>) {
    for (const path of files.keys()) {
      sourcePathSchema.parse(path);
      if (path.split("/").some((p) => p.toLowerCase() === ".git"))
        throw new Error(".git is reserved for repository data");
    }
    this.setWorktree(files);
  }
  private setWorktree(files: ReadonlyMap<string, GitFile>) {
    for (const path of this.ignoreFiles) this.fs.remove(`${this.dir}/${path}`);
    this.ignoreFiles = [];
    this.worktree = new Map(files);
  }
  async blob(oid: string): Promise<Uint8Array<ArrayBuffer>> {
    const { blob } = await git.readBlob({ ...this.args(), oid });
    return blob as Uint8Array<ArrayBuffer>;
  }
  private async headOid() {
    try {
      return await git.resolveRef({ ...this.args(), ref: "HEAD" });
    } catch (error) {
      if (error instanceof git.Errors.NotFoundError) return null;
      throw error;
    }
  }
  private async readHead(): Promise<HeadTree> {
    const oid = await this.headOid();
    if (!oid) return { files: new Map(), folders: new Map() };
    if (this.loadedHead?.oid === oid) return this.loadedHead.tree;
    const tree: HeadTree = { files: new Map(), folders: new Map() };
    const pending = [{ path: "", oid }];
    let entries = 0;
    for (let folder = pending.pop(); folder; folder = pending.pop()) {
      const read = await git.readTree({ ...this.args(), oid: folder.oid });
      tree.folders.set(folder.path, read.oid);
      for (const entry of read.tree) {
        if (++entries > maxTreeEntries)
          throw new Error("Repository has too many files and folders.");
        const path = folder.path ? `${folder.path}/${entry.path}` : entry.path;
        if (entry.type === "tree") pending.push({ path, oid: entry.oid });
        else
          tree.files.set(path, {
            oid: entry.oid,
            mode: entry.mode,
            type: entry.type,
          });
      }
    }
    this.loadedHead = { oid, tree };
    return tree;
  }
  /** Ignored files, when the working tree is clean. Git leaves them alone. */
  private async untracked() {
    const { files: tracked } = await this.readHead();
    return new Map([...this.worktree].filter(([path]) => !tracked.has(path)));
  }
  // Makes HEAD's files the working tree, if a project can hold them.
  private async checkoutHead(untracked: ReadonlyMap<string, GitFile>) {
    const { files: tracked } = await this.readHead();
    const files = new Map(untracked);
    for (const [path, { oid, mode, type }] of tracked) {
      if (isGenerated(path)) continue;
      if (mode === "120000")
        throw new Error(
          "Symbolic links are not supported in Texfolia projects.",
        );
      if (type === "commit" || path === ".gitmodules")
        throw new Error("Submodules are not supported in Texfolia projects.");
      sourcePathSchema.parse(path);
      if (path.split("/").some((p) => p.toLowerCase() === ".git"))
        throw new Error(".git is reserved for repository data");
      const local = files.get(path);
      if (local) {
        local.oid ??= await hashFile(local);
        if (local.oid !== oid)
          throw new Error(
            `${path} is ignored here but tracked in Git. Rename or delete it, then try again.`,
          );
      }
      files.set(path, { oid, read: () => this.blob(oid) });
    }
    // The editor's file tree is case insensitive, including folder components.
    const folders = new Map<string, string>();
    const lowerPaths = new Set<string>();
    for (const path of files.keys()) {
      lowerPaths.add(path.toLowerCase());
      for (const folder of parentFolders(path).slice(1)) {
        const lower = folder.toLowerCase();
        if ((folders.get(lower) ?? folder) !== folder)
          throw new Error("Repository has case-colliding file paths.");
        folders.set(lower, folder);
      }
    }
    if (
      lowerPaths.size < files.size ||
      [...lowerPaths].some((path) => folders.has(path))
    )
      throw new Error("Repository has case-colliding file paths.");
    if (files.size > 1000)
      throw new Error("Repository exceeds 1,000 source files.");
    this.setWorktree(files);
  }
  async init(url?: string) {
    await git.init({ ...this.args(), defaultBranch: "main" });
    if (url) await git.addRemote({ ...this.args(), remote: "origin", url });
  }
  async clone(url: string, http: git.HttpClient) {
    const info = await git.listServerRefs({ http, url, prefix: "refs/heads/" });
    if (!info.length) {
      await this.init(url);
      return;
    }
    await git.clone({
      ...this.args(),
      http,
      url,
      singleBranch: true,
      depth: 50,
      noCheckout: true,
    });
    await this.remoteBranches(http, url);
    await this.checkoutHead(new Map());
  }
  async remoteBranches(http: git.HttpClient, url: string) {
    const refs = await git.listServerRefs({ http, url, prefix: "refs/heads/" });
    for (const ref of refs) {
      // The host chooses these names. One that cannot be checked out is left out.
      const name = ref.ref.slice("refs/heads/".length);
      if (
        !ref.ref.startsWith("refs/heads/") ||
        name === "HEAD" ||
        gitBranchSchema.safeParse(name).data !== name
      )
        continue;
      await git.writeRef({
        ...this.args(),
        ref: `refs/remotes/origin/${name}`,
        value: ref.oid,
        force: true,
      });
    }
  }
  async requireEmptyRemote(url: string, http: git.HttpClient) {
    const info = await git.listServerRefs({ http, url, prefix: "refs/heads/" });
    if (info.some((ref) => ref.ref.startsWith("refs/heads/")))
      throw new Error(
        "Link an empty repository, or import this repository as a new project to keep its history.",
      );
    if (!this.fs.has(`${this.gitdir}/HEAD`)) await this.init();
    await git.addRemote({ ...this.args(), remote: "origin", url });
  }
  async currentBranch() {
    return (await git.currentBranch(this.args())) ?? null;
  }
  private async ignored(path: string) {
    return git.isIgnored({ ...this.args(), filepath: path });
  }
  // Ignore rules are read by path, so they have to be in the file system.
  private async loadIgnoreFiles() {
    let bytes = 0;
    for (const [path, file] of this.worktree) {
      if (path.split("/").at(-1) !== ".gitignore") continue;
      if (this.fs.has(`${this.dir}/${path}`)) continue;
      const value =
        (file.sizeBytes ?? 0) > maxIgnoreBytes ? null : await file.read();
      bytes += value?.byteLength ?? 0;
      if (!value || bytes > maxIgnoreBytes)
        throw new Error(".gitignore files exceed 1 MiB.");
      this.fs.add(`${this.dir}/${path}`, value);
      this.ignoreFiles.push(path);
    }
  }
  private async changes(): Promise<GitStatus["changes"]> {
    const { files: tracked } = await this.readHead();
    const files = [...this.worktree].filter(([path]) => !isGenerated(path));
    // Only a tracked file whose blob is unknown has to be read.
    await mapLimit(
      files.flatMap(([path, file]) =>
        tracked.has(path) && !file.oid ? [file] : [],
      ),
      6,
      async (file) => {
        file.oid = await hashFile(file);
      },
      {
        maxBytes: 12 * 1024 * 1024,
        size: (file) => file.sizeBytes ?? 4 * 1024 * 1024,
      },
    );
    if (files.some(([path]) => !tracked.has(path)))
      await this.loadIgnoreFiles();
    const changes: GitStatus["changes"] = [];
    for (const [path, file] of files) {
      const entry = tracked.get(path);
      if (!entry) {
        if (!(await this.ignored(path)))
          changes.push({ path, status: "added" });
      } else if (entry.oid !== file.oid)
        changes.push({ path, status: "modified" });
    }
    for (const [path, { type }] of tracked)
      if (type === "blob" && !isGenerated(path) && !this.worktree.has(path))
        changes.push({ path, status: "deleted" });
    return changes.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }
  async status(): Promise<Omit<GitStatus, "remote">> {
    const changes = await this.changes();
    let commits: GitStatus["commits"] = [];
    try {
      commits = (await git.log({ ...this.args(), depth: 30 })).map(
        ({ oid, commit }) => ({
          oid,
          message: commit.message.trim(),
          author: commit.author.name,
          timestamp: commit.author.timestamp,
        }),
      );
    } catch (error) {
      if (!(error instanceof git.Errors.NotFoundError)) throw error;
    }
    return {
      branch: await this.currentBranch(),
      branches: [
        ...new Set([
          ...(await git.listBranches(this.args())),
          ...(
            await git.listBranches({ ...this.args(), remote: "origin" })
          ).filter((name) => name !== "HEAD"),
        ]),
      ].sort(),
      changes,
      commits,
    };
  }
  async diff() {
    const changes = await this.changes();
    const { files: tracked } = await this.readHead();
    let result = "";
    for (const change of changes) {
      const summary = `${change.status} ${change.path} (binary or large file)\n`;
      const file = this.worktree.get(change.path);
      if ((file?.sizeBytes ?? 0) > maxDiffFileBytes) result += summary;
      else {
        const entry = tracked.get(change.path);
        const before = entry ? await this.blob(entry.oid) : new Uint8Array();
        const after = file ? await file.read() : new Uint8Array();
        result +=
          before.includes(0) ||
          after.includes(0) ||
          before.length + after.length > maxDiffFileBytes
            ? summary
            : createPatch(
                change.path,
                new TextDecoder().decode(before),
                new TextDecoder().decode(after),
              );
      }
      if (result.length > 48 * 1024)
        return `${result.slice(0, 48 * 1024)}\n[diff truncated]`;
    }
    return result;
  }
  async commit(message: string, author: { name: string; email: string }) {
    if (!message.trim()) throw new Error("Write a commit message.");
    const changes = await this.changes();
    if (!changes.length) throw new Error("No changes to commit.");
    const head = await this.readHead();
    const files = new Map(head.files);
    for (const { path } of changes) {
      const file = this.worktree.get(path);
      if (!file) {
        files.delete(path);
        continue;
      }
      file.oid = await git.writeBlob({
        ...this.args(),
        blob: await file.read(),
      });
      files.set(path, {
        oid: file.oid,
        mode: head.files.get(path)?.mode ?? "100644",
        type: "blob",
      });
    }
    return git.commit({
      ...this.args(),
      message: message.trim(),
      author,
      tree: await this.writeTree(
        files,
        head.folders,
        changes.map(({ path }) => path),
      ),
    });
  }
  // Writes the trees of changed folders, and keeps the others'.
  private async writeTree(
    files: Map<string, TreeEntry>,
    folders: Map<string, string>,
    changed: string[],
  ) {
    const dirty = new Set(["", ...changed.flatMap(parentFolders)]);
    type Entry = { path: string; mode: string; oid: string; type: string };
    const contents = new Map<string, Entry[]>([["", []]]);
    const add = (folder: string, entry: Entry) => {
      const entries = contents.get(folder);
      if (entries) entries.push(entry);
      else contents.set(folder, [entry]);
    };
    for (const [path, entry] of files) {
      const at = path.lastIndexOf("/");
      add(path.slice(0, Math.max(at, 0)), {
        ...entry,
        path: path.slice(at + 1),
      });
      for (const folder of parentFolders(path))
        if (!contents.has(folder)) contents.set(folder, []);
    }
    // Deepest first, so a folder's subfolders are written before it.
    const depth = (folder: string) => folder.split("/").length;
    const order = [...contents.keys()]
      .filter(Boolean)
      .sort((a, b) => depth(b) - depth(a));
    const write = async (folder: string) => {
      const known = dirty.has(folder) ? undefined : folders.get(folder);
      return (
        known ??
        git.writeTree({
          ...this.args(),
          tree: (contents.get(folder) ?? []) as git.TreeObject,
        })
      );
    };
    for (const folder of order) {
      const at = folder.lastIndexOf("/");
      add(folder.slice(0, Math.max(at, 0)), {
        path: folder.slice(at + 1),
        mode: "040000",
        oid: await write(folder),
        type: "tree",
      });
    }
    return write("");
  }
  async push(http: git.HttpClient) {
    const ref = await git.currentBranch(this.args());
    if (!ref) throw new Error("Choose a branch before pushing.");
    await git.push({
      ...this.args(),
      http,
      remote: "origin",
      ref,
      remoteRef: ref,
    });
  }
  async requireClean() {
    if ((await this.changes()).length)
      throw new Error(
        "Commit your changes before pulling or switching branches.",
      );
  }
  // Pulling and switching branches fetch first, which needs only the remote, and
  // then change files, which needs no network.
  async fetchCurrent(http: git.HttpClient) {
    const ref = await git.currentBranch(this.args());
    if (!ref) throw new Error("Choose a branch before pulling.");
    const { fetchHead, fetchHeadDescription } = await git.fetch({
      ...this.args(),
      http,
      remote: "origin",
      ref,
      singleBranch: true,
    });
    if (!fetchHead) throw new Error("The remote repository has no branches.");
    return { ref, theirs: fetchHead, message: `Merge ${fetchHeadDescription}` };
  }
  async merge(
    {
      ref,
      theirs,
      message,
    }: Awaited<ReturnType<GitRepository["fetchCurrent"]>>,
    author: { name: string; email: string },
  ) {
    await this.requireClean();
    const untracked = await this.untracked();
    await git.merge({ ...this.args(), ours: ref, theirs, message, author });
    await this.checkoutHead(untracked);
  }
  async pull(http: git.HttpClient, author: { name: string; email: string }) {
    await this.requireClean();
    await this.merge(await this.fetchCurrent(http), author);
  }
  async branch(name: string) {
    await git.branch({ ...this.args(), ref: name });
  }
  async hasLocalBranch(name: string) {
    return (await git.listBranches(this.args())).includes(name);
  }
  async fetchBranch(name: string, http: git.HttpClient) {
    await git.fetch({
      ...this.args(),
      http,
      remote: "origin",
      ref: name,
      singleBranch: true,
      depth: 50,
    });
  }
  async switchBranch(name: string) {
    await this.requireClean();
    const untracked = await this.untracked();
    await git.checkout({ ...this.args(), ref: name, noCheckout: true });
    await this.checkoutHead(untracked);
  }
  async checkout(name: string, http?: git.HttpClient) {
    await this.requireClean();
    if (!(await this.hasLocalBranch(name))) {
      if (!http)
        throw new Error(
          "Connect repository access before switching to a remote branch.",
        );
      await this.fetchBranch(name, http);
    }
    await this.switchBranch(name);
  }
}

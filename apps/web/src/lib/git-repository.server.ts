import { createPatch } from "diff";
import * as git from "isomorphic-git";
import { createFsFromVolume, Volume } from "memfs";
import { z } from "zod";

import type { GitStatus } from "./git";
import {
  decodeSource,
  encodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
} from "./project-source";
import { sourcePathSchema } from "./source-path.schema";

const maxRepositoryBytes = 20 * 1024 * 1024;
const storedGitSchema = z.record(z.string(), z.string());
export type GitFiles = Record<string, Uint8Array>;

export function gitHttp(url: string, token: string): git.HttpClient {
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
      if (request.body)
        for await (const part of request.body) parts.push(new Uint8Array(part));
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Basic ${btoa(`oauth2:${token}`)}`);
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
            if (bytes > maxRepositoryBytes)
              throw new Error(
                "Git transfer exceeds 20 MiB. Use a smaller repository.",
              );
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

export class GitRepository {
  private volume = new Volume();
  readonly fs = createFsFromVolume(this.volume);
  readonly dir = "/repo";
  constructor() {
    this.volume.mkdirSync(this.dir);
  }
  private args() {
    return { fs: this.fs, dir: this.dir };
  }

  static restore(serialized: string) {
    const repo = new GitRepository();
    for (const [path, value] of Object.entries(
      storedGitSchema.parse(JSON.parse(serialized)),
    )) {
      if (
        !path.startsWith(".git/") ||
        path.split("/").some((p) => p === ".." || p === "." || !p)
      )
        throw new Error("Invalid repository data");
      repo.write(path, decodeSource(value));
    }
    return repo;
  }
  serialize() {
    const files: Record<string, string> = {};
    let size = 0;
    for (const [path, value] of Object.entries(this.readAll(true))) {
      size += value.length;
      if (size > maxRepositoryBytes)
        throw new Error(
          "Git history exceeds 20 MiB. Use a smaller repository.",
        );
      files[path] = encodeSource(value);
    }
    return JSON.stringify(files);
  }
  write(path: string, value: Uint8Array) {
    this.volume.mkdirSync(
      `${this.dir}/${path.split("/").slice(0, -1).join("/")}`,
      { recursive: true },
    );
    this.volume.writeFileSync(`${this.dir}/${path}`, value);
  }
  overlay(files: GitFiles) {
    for (const name of this.volume.readdirSync(this.dir))
      if (name !== ".git")
        this.volume.rmSync(`${this.dir}/${name}`, {
          recursive: true,
          force: true,
        });
    for (const [path, value] of Object.entries(files)) {
      sourcePathSchema.parse(path);
      if (path.split("/").some((p) => p.toLowerCase() === ".git"))
        throw new Error(".git is reserved for repository data");
      this.write(path, value);
    }
  }
  private read(path: string) {
    const data = this.volume.readFileSync(`${this.dir}/${path}`);
    if (typeof data === "string") throw new Error("Expected binary file data");
    return new Uint8Array(data);
  }
  private readAll(metadata = false): GitFiles {
    const files: GitFiles = {};
    const walk = (path: string) => {
      for (const name of this.volume.readdirSync(`${this.dir}/${path}`)) {
        const relative = `${path}${name}`;
        const stat = this.volume.lstatSync(`${this.dir}/${relative}`);
        if (stat.isSymbolicLink())
          throw new Error(
            "Symbolic links are not supported in Texfolia projects.",
          );
        if (stat.isDirectory()) walk(`${relative}/`);
        else files[relative] = this.read(relative);
      }
    };
    if (metadata) walk(".git/");
    else
      for (const name of this.volume.readdirSync(this.dir)) {
        if (name === ".git" || String(name).toLowerCase() === "out") continue;
        const stat = this.volume.lstatSync(`${this.dir}/${name}`);
        if (stat.isSymbolicLink())
          throw new Error(
            "Symbolic links are not supported in Texfolia projects.",
          );
        if (stat.isDirectory()) walk(`${name}/`);
        else files[String(name)] = this.read(String(name));
      }
    return files;
  }
  sources() {
    const files = this.readAll();
    if (Object.hasOwn(files, ".gitmodules"))
      throw new Error("Submodules are not supported in Texfolia projects.");
    let bytes = 0;
    const paths = new Set<string>();
    for (const [path, value] of Object.entries(files)) {
      sourcePathSchema.parse(path);
      if (path.split("/").some((p) => p.toLowerCase() === ".git"))
        throw new Error(".git is reserved for repository data");
      // The editor's file tree is case insensitive, including folder components.
      const segments = path.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join("/");
        const existing = [...paths].find(
          (p) => p.toLowerCase() === prefix.toLowerCase(),
        );
        if (existing && existing !== prefix)
          throw new Error("Repository has case-colliding file paths.");
        paths.add(prefix);
      }
      bytes += value.length;
      if (value.length > maxSourceFileBytes || bytes > maxSourceProjectBytes)
        throw new Error(
          "Repository exceeds project source limits (10 MiB per file, 50 MiB total).",
        );
    }
    if (Object.keys(files).length > 1000)
      throw new Error("Repository exceeds 1,000 source files.");
    return files;
  }
  async init(url: string) {
    await git.init({ ...this.args(), defaultBranch: "main" });
    await git.addRemote({ ...this.args(), remote: "origin", url });
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
    });
    await this.remoteBranches(http, url);
    this.sources();
  }
  async remoteBranches(http: git.HttpClient, url: string) {
    const refs = await git.listServerRefs({ http, url, prefix: "refs/heads/" });
    for (const ref of refs)
      await git.writeRef({
        ...this.args(),
        ref: `refs/remotes/origin/${ref.ref.slice("refs/heads/".length)}`,
        value: ref.oid,
        force: true,
      });
  }
  async requireEmptyRemote(url: string, http: git.HttpClient) {
    const info = await git.listServerRefs({ http, url, prefix: "refs/heads/" });
    if (info.some((ref) => ref.ref.startsWith("refs/heads/")))
      throw new Error(
        "Link an empty repository, or import this repository as a new project to keep its history.",
      );
    await this.init(url);
  }
  private async matrix() {
    return git.statusMatrix(this.args());
  }
  async status(): Promise<Omit<GitStatus, "remote">> {
    const matrix = await this.matrix();
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
      branch: (await git.currentBranch(this.args())) ?? null,
      branches: [
        ...new Set([
          ...(await git.listBranches(this.args())),
          ...(
            await git.listBranches({ ...this.args(), remote: "origin" })
          ).filter((name) => name !== "HEAD"),
        ]),
      ].sort(),
      changes: matrix
        .filter(
          ([path, head, work]) =>
            head !== work && path.split("/")[0]?.toLowerCase() !== "out",
        )
        .map(([path, head, work]) => ({
          path,
          status: head === 0 ? "added" : work === 0 ? "deleted" : "modified",
        })),
      commits,
    };
  }
  async diff() {
    const changes = (await this.status()).changes;
    let result = "";
    for (const change of changes) {
      let before = new Uint8Array();
      if (change.status !== "added")
        before = new Uint8Array(
          (
            await git.readBlob({
              ...this.args(),
              oid: await git.resolveRef({ ...this.args(), ref: "HEAD" }),
              filepath: change.path,
            })
          ).blob,
        );
      const after =
        change.status === "deleted" ? new Uint8Array() : this.read(change.path);
      if (
        before.includes(0) ||
        after.includes(0) ||
        before.length + after.length > 128 * 1024
      )
        result += `${change.status} ${change.path} (binary or large file)\n`;
      else
        result += createPatch(
          change.path,
          new TextDecoder().decode(before),
          new TextDecoder().decode(after),
        );
      if (result.length > 48 * 1024)
        return `${result.slice(0, 48 * 1024)}\n[diff truncated]`;
    }
    return result;
  }
  async commit(message: string, author: { name: string; email: string }) {
    if (!message.trim()) throw new Error("Write a commit message.");
    const changes = (await this.status()).changes;
    if (!changes.length) throw new Error("No changes to commit.");
    for (const change of changes) {
      if (change.status === "deleted")
        await git.remove({ ...this.args(), filepath: change.path });
      else await git.add({ ...this.args(), filepath: change.path });
    }
    return git.commit({ ...this.args(), message: message.trim(), author });
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
  private async requireClean() {
    if ((await this.status()).changes.length)
      throw new Error(
        "Commit your changes before pulling or switching branches.",
      );
  }
  async pull(http: git.HttpClient, author: { name: string; email: string }) {
    await this.requireClean();
    await git.pull({
      ...this.args(),
      http,
      remote: "origin",
      singleBranch: true,
      author,
    });
    this.sources();
  }
  async branch(name: string) {
    await git.branch({ ...this.args(), ref: name });
  }
  async hasLocalBranch(name: string) {
    return (await git.listBranches(this.args())).includes(name);
  }
  async checkout(name: string, http?: git.HttpClient) {
    await this.requireClean();
    if (!(await this.hasLocalBranch(name))) {
      if (!http)
        throw new Error(
          "Connect repository access before switching to a remote branch.",
        );
      await git.fetch({
        ...this.args(),
        http,
        remote: "origin",
        ref: name,
        singleBranch: true,
        depth: 50,
      });
    }
    await git.checkout({ ...this.args(), ref: name });
    this.sources();
  }
}

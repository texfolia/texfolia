// The in-memory file system that isomorphic-git runs on. It holds a repository's
// `.git` folder and its .gitignore files, never the project's other files. Unlike
// a general one, reading or writing a large pack does not copy it, and it refuses
// to grow past a limit instead of running the Worker out of memory.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function failure(code: string, path: string) {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function parentOf(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function nameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

class GitStat {
  readonly mtimeMs = 0;
  readonly ctimeMs = 0;
  readonly ino = 0;
  readonly dev = 0;
  readonly uid = 0;
  readonly gid = 0;
  constructor(
    private directory: boolean,
    readonly size: number,
  ) {}
  get type() {
    return this.directory ? "dir" : "file";
  }
  get mode() {
    return this.directory ? 0o040000 : 0o100644;
  }
  isFile() {
    return !this.directory;
  }
  isDirectory() {
    return this.directory;
  }
  isSymbolicLink() {
    return false;
  }
}

export class GitFs {
  private files = new Map<string, Uint8Array<ArrayBuffer>>();
  private folders = new Map<string, Set<string>>([["/", new Set()]]);
  private bytes = 0;

  /** `onFull` makes the error for a write past `maxBytes`. */
  constructor(
    private maxBytes: number,
    private onFull: () => Error,
  ) {}

  // isomorphic-git calls these by name.
  readonly promises = {
    readFile: async (path: string, options?: string | { encoding?: string }) =>
      this.readFile(path, options),
    writeFile: async (path: string, data: string | Uint8Array) =>
      this.writeFile(path, data),
    unlink: async (path: string) => this.unlink(path),
    readdir: async (path: string) => [...this.folder(path)],
    mkdir: async (path: string) => this.mkdir(path),
    rmdir: async (path: string) => this.rmdir(path),
    stat: async (path: string) => this.stat(path),
    lstat: async (path: string) => this.stat(path),
    readlink: async (path: string) => {
      throw failure("EINVAL", path);
    },
    symlink: async (path: string) => {
      throw failure("EPERM", path);
    },
  };

  /** Every file under `folder`, by path relative to it. */
  *list(folder: string): Generator<[string, Uint8Array<ArrayBuffer>]> {
    for (const [path, value] of this.files)
      if (path.startsWith(`${folder}/`))
        yield [path.slice(folder.length + 1), value];
  }

  has(path: string) {
    return this.files.has(path);
  }

  size(path: string) {
    return this.files.get(path)?.byteLength;
  }

  /** Writes a file, creating its folders. */
  add(path: string, data: string | Uint8Array) {
    const missing: string[] = [];
    for (
      let folder = parentOf(path);
      !this.folders.has(folder);
      folder = parentOf(folder)
    )
      missing.unshift(folder);
    for (const folder of missing) this.mkdir(folder);
    this.writeFile(path, data);
  }

  remove(path: string) {
    if (this.files.has(path)) this.unlink(path);
  }

  private folder(path: string) {
    const entries = this.folders.get(path);
    if (entries) return entries;
    throw failure(this.files.has(path) ? "ENOTDIR" : "ENOENT", path);
  }

  private readFile(path: string, options?: string | { encoding?: string }) {
    const value = this.files.get(path);
    if (!value)
      throw failure(this.folders.has(path) ? "EISDIR" : "ENOENT", path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding) return decoder.decode(value);
    // isomorphic-git wraps this with Buffer.from, which copies a typed array but
    // shares an ArrayBuffer. It never writes to what it reads.
    return value.buffer;
  }

  private writeFile(path: string, data: string | Uint8Array) {
    if (this.folders.has(path)) throw failure("EISDIR", path);
    const entries = this.folder(parentOf(path));
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const total =
      this.bytes - (this.files.get(path)?.byteLength ?? 0) + bytes.byteLength;
    if (total > this.maxBytes) throw this.onFull();
    // Keeps a whole buffer without copying it, but never a view of a shared one.
    const value =
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteLength === bytes.buffer.byteLength
        ? new Uint8Array(bytes.buffer)
        : new Uint8Array(bytes);
    this.bytes = total;
    this.files.set(path, value);
    entries.add(nameOf(path));
  }

  private unlink(path: string) {
    const value = this.files.get(path);
    if (!value) throw failure("ENOENT", path);
    this.bytes -= value.byteLength;
    this.files.delete(path);
    this.folders.get(parentOf(path))?.delete(nameOf(path));
  }

  private mkdir(path: string) {
    if (this.folders.has(path) || this.files.has(path))
      throw failure("EEXIST", path);
    this.folder(parentOf(path)).add(nameOf(path));
    this.folders.set(path, new Set());
  }

  private rmdir(path: string) {
    if (this.folder(path).size) throw failure("ENOTEMPTY", path);
    this.folders.delete(path);
    this.folders.get(parentOf(path))?.delete(nameOf(path));
  }

  private stat(path: string) {
    const value = this.files.get(path);
    if (!value && !this.folders.has(path)) throw failure("ENOENT", path);
    return new GitStat(!value, value?.byteLength ?? 0);
  }
}

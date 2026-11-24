import { CollaborativeFile } from "./file";
import {
  finishUnmarkedDocuments,
  unmarkedDocuments,
  unsyncedDocuments,
} from "./unsynced";

type FileOptions = ConstructorParameters<typeof CollaborativeFile>[0];
type Saved = Parameters<NonNullable<FileOptions["onSaved"]>>[0];

// Unmarked caches are checked a few at a time, since a project may have many.
const unmarkedLimit = 4;

/**
 * The live documents of one project. A document connects while something holds
 * it, such as an open tab. After its last hold is released it stays connected
 * until its edits are saved, then closes.
 */
export class CollaborativeDocuments {
  private files = new Map<string, CollaborativeFile>();
  private holds = new Map<string, number>();
  private closing = new Map<string, ReturnType<typeof setTimeout>>();
  private saving = new Set<string>();
  // Documents held until they synchronize edits cached by an earlier session.
  private recovering = new Set<string>();
  private unmarked: string[] | undefined;
  private recoveryStarted = false;
  private destroyed = false;
  private project = {
    textIds: new Set<string>() as ReadonlySet<string>,
    deleted: new Set<string>() as ReadonlySet<string>,
    canWrite: false,
  };

  constructor(
    private options: Pick<FileOptions, "projectId" | "userId"> & {
      /** How long a released document stays connected, so reopening is cheap. */
      closeDelayMs?: number;
      /** False when no document was ever cached without an unsynced marker. */
      recoverUnmarked?: boolean;
      onChange: (id: string, value: string, local: boolean | undefined) => void;
      onSaved: (id: string, saved: Saved, file: CollaborativeFile) => void;
      /** Called before a document closes, while its text can still be read. */
      onClose: (id: string, file: CollaborativeFile) => void;
      /** Called when a document opens, first loads its text, or closes. */
      onDocuments: () => void;
    },
  ) {}

  /** Applies the project's files and access, opening held documents. */
  update(project: {
    textIds: ReadonlySet<string>;
    deleted: ReadonlySet<string>;
    canWrite: boolean;
  }) {
    this.destroyed = false;
    this.project = project;
    for (const file of this.files.values())
      file.refreshAccess(project.canWrite);
    for (const id of this.holds.keys()) this.open(id);
    for (const id of project.deleted) {
      this.recovered(id);
      // Keep deleted documents and their panels available for copying/recovery.
      // Retiring stops reconnects without discarding the IndexedDB document.
      this.files.get(id)?.retire();
      this.scheduleClose(id);
    }
    if (project.canWrite && !this.recoveryStarted) {
      this.recoveryStarted = true;
      void this.recover();
    }
  }

  get(id: string) {
    return this.files.get(id);
  }

  snapshot(): ReadonlyMap<string, CollaborativeFile> {
    return new Map(this.files);
  }

  /** Connects a document until the returned function is called. */
  hold(id: string) {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    this.open(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.holds.get(id) ?? 1) - 1;
      if (count) this.holds.set(id, count);
      else this.holds.delete(id);
      this.scheduleClose(id);
    };
  }

  /** Edits a document, connecting it first when it is not open. */
  async edit(id: string, run: (file: CollaborativeFile) => void) {
    const release = this.hold(id);
    try {
      const file = this.files.get(id);
      if (!file) throw new Error("This file is not available for editing.");
      await file.whenReady();
      run(file);
    } finally {
      release();
    }
  }

  /**
   * Waits until every document in use, and every one with unsaved edits, is
   * connected, and returns them. Other files have no edits from this browser.
   */
  async synchronize() {
    const current = [...this.files].filter(
      ([id, file]) =>
        !this.project.deleted.has(id) &&
        (this.held(id) || file.hasPendingEdits()),
    );
    await Promise.all(current.map(([, file]) => file.whenConnected()));
    return new Map(current);
  }

  destroy() {
    this.destroyed = true;
    for (const timer of this.closing.values()) clearTimeout(timer);
    this.closing.clear();
    this.recovering.clear();
    this.unmarked = undefined;
    this.recoveryStarted = false;
    for (const file of this.files.values()) file.destroy();
    this.files.clear();
  }

  private held(id: string) {
    return this.holds.has(id) || this.recovering.has(id);
  }

  private open(id: string) {
    clearTimeout(this.closing.get(id));
    this.closing.delete(id);
    if (
      this.destroyed ||
      this.files.has(id) ||
      !this.project.textIds.has(id) ||
      this.project.deleted.has(id)
    )
      return;
    let initialized = false;
    const file: CollaborativeFile = new CollaborativeFile({
      projectId: this.options.projectId,
      nodeId: id,
      userId: this.options.userId,
      canWrite: this.project.canWrite,
      onSaved: (saved) => {
        this.options.onSaved(id, saved, file);
        this.scheduleClose(id);
      },
      onChange: (value, local) => {
        this.options.onChange(id, value, local);
        if (!initialized) {
          initialized = true;
          this.options.onDocuments();
        }
        if (file.getStatus().connected) this.recovered(id);
        this.scheduleClose(id);
      },
    });
    this.files.set(id, file);
    this.options.onDocuments();
  }

  private scheduleClose(id: string) {
    if (this.held(id) || !this.files.has(id)) return;
    clearTimeout(this.closing.get(id));
    this.closing.set(
      id,
      setTimeout(() => {
        this.closing.delete(id);
        this.close(id);
      }, this.options.closeDelayMs ?? 2000),
    );
  }

  private close(id: string) {
    const file = this.files.get(id);
    if (!file || this.held(id) || this.saving.has(id)) return;
    if (!file.hasPendingEdits()) {
      this.files.delete(id);
      this.options.onClose(id, file);
      file.destroy();
      this.options.onDocuments();
      return;
    }
    // Offline documents stay open, and try again after they synchronize.
    if (!file.getStatus().connected) return;
    this.saving.add(id);
    file.save().then(
      () => {
        this.saving.delete(id);
        this.close(id);
      },
      // The edits stay open, so the next save includes them.
      () => this.saving.delete(id),
    );
  }

  // Merges edits that an earlier session cached but never synchronized.
  private async recover() {
    for (const id of unsyncedDocuments(this.options))
      if (this.project.textIds.has(id)) {
        this.recovering.add(id);
        this.open(id);
      }
    if (this.options.recoverUnmarked === false) return;
    try {
      const unmarked = await unmarkedDocuments(this.options);
      if (this.destroyed) return;
      this.unmarked = unmarked.filter((id) => this.project.textIds.has(id));
      this.recoverUnmarked();
    } catch (error) {
      console.error("Cached documents could not be listed", error);
    }
  }

  private recoverUnmarked() {
    if (!this.unmarked) return;
    while (this.recovering.size < unmarkedLimit) {
      const id = this.unmarked.pop();
      if (id === undefined) break;
      const connected = this.files.get(id)?.getStatus().connected;
      if (connected || !this.project.textIds.has(id)) continue;
      this.recovering.add(id);
      this.open(id);
    }
    if (this.unmarked.length || this.recovering.size) return;
    this.unmarked = undefined;
    finishUnmarkedDocuments(this.options);
  }

  private recovered(id: string) {
    if (this.recovering.delete(id)) this.recoverUnmarked();
  }
}

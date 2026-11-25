/** A file's live and saved text. */
export type FileState = { value: string; savedValue: string };

/**
 * The text of each project file, shared with the editors by reference. Reading
 * a draft never renders anything; `subscribe` is for views that show the text.
 */
export class FileDrafts extends Map<string, FileState> {
  private listeners = new Set<() => void>();
  private revision = 0;

  override set(id: string, next: FileState) {
    const previous = this.get(id);
    super.set(id, next);
    if (
      previous?.value === next.value &&
      previous.savedValue === next.savedValue
    )
      return this;
    this.revision++;
    for (const listener of this.listeners) listener();
    return this;
  }

  /** Changes whenever a draft's live or saved text does. */
  getRevision = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** The live text of each file that has some, by path. */
export function draftSources(
  paths: ReadonlyMap<string, string>,
  drafts: ReadonlyMap<string, FileState>,
) {
  return [...paths].flatMap(([nodeId, path]) => {
    const draft = drafts.get(nodeId);
    return draft ? [{ nodeId, path, text: draft.value }] : [];
  });
}

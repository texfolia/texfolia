import { buildSnapshotSchema, type BuildSnapshot } from "../build";

type BuildEvent =
  | { kind: "snapshot"; snapshot: BuildSnapshot }
  | { kind: "disconnected" };

export class ProjectBuildEvents {
  private source: EventSource;
  private listeners = new Set<(event: BuildEvent) => void>();
  private snapshot: BuildSnapshot | null = null;
  private disconnected = false;

  constructor(
    projectId: string,
    onSnapshot: (snapshot: BuildSnapshot) => void,
  ) {
    this.source = new EventSource(
      `/api/compile/${encodeURIComponent(projectId)}?events=1`,
    );
    this.source.onmessage = (event) => {
      let snapshot: BuildSnapshot;
      try {
        snapshot = buildSnapshotSchema.parse(JSON.parse(event.data));
      } catch {
        return;
      }
      const previous = this.snapshot;
      if (previous && snapshot.revision < previous.revision) return;
      if (
        previous?.current &&
        snapshot.current?.id === previous.current.id &&
        (snapshot.current.revision < previous.current.revision ||
          (["queued", "running"].includes(snapshot.current.status) &&
            ["succeeded", "failed"].includes(previous.current.status)))
      )
        return;
      this.snapshot = snapshot;
      onSnapshot(snapshot);
      for (const listener of this.listeners)
        listener({ kind: "snapshot", snapshot });
    };
    this.source.onopen = () => {
      this.disconnected = false;
    };
    this.source.onerror = () => {
      if (this.disconnected) return;
      this.disconnected = true;
      for (const listener of this.listeners) listener({ kind: "disconnected" });
    };
  }

  subscribe(listener: (event: BuildEvent) => void) {
    this.listeners.add(listener);
    if (this.snapshot) listener({ kind: "snapshot", snapshot: this.snapshot });
    if (this.disconnected) listener({ kind: "disconnected" });
    return () => this.listeners.delete(listener);
  }

  close() {
    this.source.close();
    this.listeners.clear();
  }
}

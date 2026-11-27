import { useEffect, useRef, useState } from "react";

import { documentCachingStopped } from "#/lib/collaboration/browser";
import type { CollaborativeFile } from "#/lib/collaboration/browser";
import {
  reconcileSourceDrafts,
  serializeSourceDrafts,
  type SourceDraft,
} from "#/lib/collaboration/browser";
import type { CompileSources } from "#/lib/compile";
import { binaryFetchLimit, mapLimit } from "#/lib/map-limit";
import {
  projectMetadataVersion,
  assertProjectSourcePaths,
  projectPaths,
} from "#/lib/projects";
import { saveProjectSource } from "#/lib/projects/project-source.functions";
import type { ProjectDetails } from "#/lib/projects/project.functions";
import {
  encodeSource,
  sourceHashFromKey,
  type SourceFiles,
} from "#/lib/storage";
import type { useProjectFiles } from "#/providers/project-files-provider";
import type { FileState } from "#/providers/workspace-provider";

export const sourceDraftsKey = (projectId: string) =>
  `texfolia.project.${projectId}.sources`;

type Saved = Awaited<ReturnType<CollaborativeFile["save"]>>;

/**
 * Saves collaborative documents to the server, snapshots sources for compiles
 * and exports, and migrates or recovers drafts cached by older versions.
 */
export function useSourceSave({
  project,
  canWrite,
  ready,
  files,
  collaboration,
  drafts,
  refreshSaved,
  refreshTitle,
}: {
  project: Pick<ProjectDetails, "id" | "sourceContents" | "sourceVersions">;
  canWrite: boolean;
  ready: boolean;
  files: ReturnType<typeof useProjectFiles>;
  collaboration: {
    synchronize: () => Promise<ReadonlyMap<string, CollaborativeFile>>;
  };
  drafts: Map<string, FileState>;
  /** Loads files without a live document at their saved version. */
  refreshSaved: () => Promise<void>;
  /** Updates a tab title after its saved value changes. */
  refreshTitle: (id: string) => void;
}) {
  const projectId = project.id;
  const storageKey = sourceDraftsKey(projectId);
  // Drafts still cached in this browser, keyed by node.
  const localDrafts = useRef<Record<string, SourceDraft>>({});
  const [recovery, setRecovery] = useState<Record<string, SourceDraft>>({});
  const [sourceError, setSourceError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const recovering = Object.keys(recovery).length > 0;

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (documentCachingStopped()) return;
      if (
        [...drafts.values()].some((draft) => draft.value !== draft.savedValue)
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);

  function cacheDrafts() {
    if (documentCachingStopped()) return;
    try {
      localStorage.setItem(
        storageKey,
        serializeSourceDrafts(localDrafts.current),
      );
    } catch {
      setSourceError(
        "Offline drafts could not be cached. Save to the server before closing this page.",
      );
    }
  }

  /** Records a save the server acknowledged and returns the live value. */
  function recordSaved(id: string, saved: Saved, value: string) {
    if (!files.recordSourceVersion(id, saved)) return false;
    drafts.set(id, { value, savedValue: saved.value });
    refreshTitle(id);
    return true;
  }

  async function saveSources() {
    if (!canWrite || !ready || recovering || saveInProgress.current)
      return false;
    saveInProgress.current = true;
    setSaving(true);
    setSourceError("");
    try {
      const metadata = await files.refresh();
      if (!metadata.canWrite)
        throw new Error("Viewers cannot save project files");
      // Files without a live document have no edits here, and the room saves
      // collaborators' edits by itself.
      const live = await collaboration.synchronize();
      await Promise.all(
        [...live].map(async ([id, file]) => {
          // Skip files the server has already persisted at the known version.
          if (
            file.isSaved(files.sourceVersions[id]?.objectKey) &&
            file.text.toString() === drafts.get(id)?.savedValue
          )
            return;
          const saved = await file.save();
          const value = file.text.toString();
          recordSaved(id, saved, value);
          if (value === saved.value) delete localDrafts.current[id];
        }),
      );
      cacheDrafts();
      return true;
    } catch (error) {
      setSourceError(
        error instanceof Error
          ? error.message
          : "Sources could not be saved. Your local draft is still available.",
      );
      return false;
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }

  async function sourceFiles(): Promise<SourceFiles>;
  async function sourceFiles(
    mode: "compile",
  ): Promise<{ sources: CompileSources; metadataVersion: string }>;
  async function sourceFiles(
    mode?: "compile",
  ): Promise<
    SourceFiles | { sources: CompileSources; metadataVersion: string }
  > {
    await files.refresh();
    const nodes = files.nodes.toArray;
    const saved = mode === "compile";
    if (saved) assertProjectSourcePaths(nodes);
    const paths = projectPaths(nodes);
    const versions = files.snapshotSourceVersions();
    const metadataVersion = await projectMetadataVersion({
      nodes,
      sourceVersions: versions,
      textSource: saved ? "saved" : "live",
    });
    const live = await collaboration.synchronize();
    if (!saved) await refreshSaved();
    const sources: CompileSources = {};
    for (const node of nodes) {
      const path = paths.get(node.id);
      if (node.kind !== "text" || !path) continue;
      const objectKey = versions[node.id]?.objectKey ?? null;
      const hash = sourceHashFromKey(objectKey);
      sources[path] = saved
        ? hash && objectKey
          ? { hash, key: objectKey }
          : ""
        : (live.get(node.id)?.text.toString() ??
          drafts.get(node.id)?.value ??
          "");
    }
    const binaries = nodes.flatMap((node) => {
      const path = paths.get(node.id);
      return node.kind === "binary" && path ? [{ id: node.id, path }] : [];
    });
    if (saved)
      for (const { id, path } of binaries) {
        const objectKey = versions[id]?.objectKey ?? null;
        const hash = sourceHashFromKey(objectKey);
        if (!hash || !objectKey)
          throw new Error(`Save ${path} before compiling`);
        sources[path] = { hash, key: objectKey };
      }
    else
      await mapLimit(binaries, binaryFetchLimit, async ({ id, path }) => {
        const response = await fetch(`/api/sources/${projectId}/${id}`);
        if (!response.ok) throw new Error(`Could not load ${path}`);
        sources[path] = {
          base64: encodeSource(new Uint8Array(await response.arrayBuffer())),
        };
      });
    if (saved) return { sources, metadataVersion };
    const current = await files.refresh();
    if (
      (await projectMetadataVersion({ ...current, textSource: "live" })) !==
      metadataVersion
    )
      throw new Error(
        "Project files changed during export. Try downloading again.",
      );
    // Export uses live collaborative text; compiled sources use saved hashes.
    const exported: SourceFiles = {};
    for (const [path, source] of Object.entries(sources)) {
      if (typeof source === "string" || "base64" in source)
        exported[path] = source;
    }
    return exported;
  }

  /**
   * Saves drafts cached by older versions of the editor, and offers any that
   * can't be saved for recovery. Returns false when `isCurrent` stops holding
   * part-way, meaning the workspace was replaced.
   */
  async function restoreBrowserDrafts({
    isCurrent,
    onMigrated,
  }: {
    isCurrent: () => boolean;
    onMigrated: (id: string, value: string) => void;
  }) {
    try {
      const { migrate, recover } = reconcileSourceDrafts({
        raw: localStorage.getItem(storageKey),
        contents: project.sourceContents,
        versions: project.sourceVersions,
      });
      localDrafts.current = { ...migrate, ...recover };
      for (const [id, draft] of Object.entries(migrate)) {
        if (!isCurrent()) return false;
        if (!canWrite) {
          recover[id] = draft;
          continue;
        }
        try {
          const version = await saveProjectSource({
            data: {
              projectId,
              nodeId: id,
              expectedObjectKey: null,
              content: encodeSource(new TextEncoder().encode(draft.value)),
            },
          });
          files.recordSourceVersion(id, version);
          drafts.set(id, { value: draft.value, savedValue: draft.value });
          onMigrated(id, draft.value);
          delete localDrafts.current[id];
        } catch {
          recover[id] = draft;
          setSourceError(
            "Some browser drafts could not be migrated. Recover them below and save when online.",
          );
        }
      }
      if (!isCurrent()) return false;
      setRecovery(recover);
      cacheDrafts();
    } catch {
      setSourceError(
        "Browser drafts could not be read. The server copy is open; the original browser cache has not been changed.",
      );
    }
    return true;
  }

  /** Applies or discards the drafts offered for recovery. */
  function resolveRecovery(apply?: (id: string, value: string) => void) {
    for (const [id, draft] of Object.entries(recovery)) {
      apply?.(id, draft.value);
      delete localDrafts.current[id];
    }
    cacheDrafts();
    setRecovery({});
  }

  return {
    saving,
    sourceError,
    recovery,
    /** True while browser drafts wait for recovery; editing is paused. */
    recovering,
    saveInProgress: () => saveInProgress.current,
    saveSources,
    sourceFiles,
    recordSaved,
    restoreBrowserDrafts,
    resolveRecovery,
  };
}

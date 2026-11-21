import { type BuildSnapshot } from "@texfolia/contracts";
import type { LatexProblem } from "@texfolia/editor/latex/analysis";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { parseCompileLog } from "#/lib/compile/compile-log";
import { requestCompilation } from "#/lib/compile/compile-project";
import { ProjectBuildEvents } from "#/lib/compile/project-build-events";
import { isCurrentBuild } from "#/lib/compile/shared-pdf";
import type { CompileSources } from "#/lib/compile/source-sync";
import { invalidProjectPaths } from "#/lib/project-paths";
import type { ProjectNode } from "#/lib/project.functions";
import { InvalidSourcePathError } from "#/lib/source-path.schema";

import { useSharedPdf } from "./use-shared-pdf";

/**
 * Identifies the tree's ids, names, parents and kinds, so edits that leave
 * them alone (such as new source versions) don't count as structure changes.
 */
function structureKey(nodes: readonly ProjectNode[]) {
  return nodes
    .map(
      ({ id, name, parentId, kind }) =>
        `${id}\u0000${name}\u0000${parentId ?? ""}\u0000${kind}`,
    )
    .sort()
    .join("\u0001");
}

export type CompileStatus =
  | "Compiling…"
  | "Compile failed"
  | "Out of date"
  | "Up to date"
  | "Not compiled";

/**
 * Tells the server this editor changed the sources, so peers see the shared
 * PDF as out of date. Each report carries a sequence; a compile claims the
 * next one so the build it starts covers every edit reported before it.
 */
function useEditNotifications(projectId: string) {
  const editorId = useRef(crypto.randomUUID());
  const sequence = useRef(0);
  const notified = useRef(0);
  const closed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      clearTimeout(timer.current);
    };
  }, [projectId]);
  return {
    editorId: editorId.current,
    /** Whether every edit so far has been reported or compiled. */
    caughtUp: () => notified.current >= sequence.current,
    /** Takes the next sequence for a compile and cancels the pending report. */
    claim() {
      clearTimeout(timer.current);
      return ++sequence.current;
    },
    acknowledge(value: number) {
      notified.current = Math.max(notified.current, value);
    },
    report() {
      const value = ++sequence.current;
      clearTimeout(timer.current);
      const send = async () => {
        try {
          const response = await fetch(
            `/api/compile/${encodeURIComponent(projectId)}?changed=1`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                editorId: editorId.current,
                sequence: value,
              }),
              keepalive: true,
            },
          );
          if (!response.ok) throw new Error("Could not report source changes");
          notified.current = Math.max(notified.current, value);
        } catch {
          if (!closed.current && value === sequence.current)
            timer.current = setTimeout(() => void send(), 2000);
        }
      };
      timer.current = setTimeout(() => void send(), 150);
    },
  };
}

/**
 * Compiles the project, follows the shared build over SSE, and schedules
 * auto-compiles after editing stops.
 */
export function useCompilation({
  projectId,
  canWrite,
  main,
  filenames,
  nodes,
  blocked,
  revision,
  afterIdle,
  saveSources,
  saveInProgress,
  sourceFiles,
}: {
  projectId: string;
  canWrite: boolean;
  main: string | undefined;
  filenames: string[];
  nodes: ProjectNode[];
  /** Compiling waits while browser drafts are pending recovery. */
  blocked: boolean;
  /** The analysis revision, bumped on every source change. */
  revision: RefObject<number>;
  afterIdle: number;
  saveSources: () => Promise<boolean>;
  saveInProgress: () => boolean;
  sourceFiles: () => Promise<{
    sources: CompileSources;
    metadataVersion: string;
  }>;
}) {
  const [build, setBuild] = useState<BuildSnapshot | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState("");
  const [compileProblems, setCompileProblems] = useState<LatexProblem[]>([]);
  const [sourceChanged, setSourceChanged] = useState(false);
  const compilation = useRef<AbortController | null>(null);
  const buildEvents = useRef<ProjectBuildEvents | null>(null);
  // The newest snapshot, read by compiles that finish after it arrives.
  const latestBuild = useRef<BuildSnapshot | null>(null);
  const lastEditAt = useRef<number | null>(null);
  const autoCompileTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Set when a usage limit rejects a build; a manual compile resumes.
  const autoCompilePaused = useRef(false);
  const edits = useEditNotifications(projectId);
  const shared = useSharedPdf({
    projectId,
    build,
    compiling,
    onError: setCompileError,
  });

  const snapshotArrived = useEffectEvent((snapshot: BuildSnapshot) => {
    latestBuild.current = snapshot;
    setBuild(snapshot);
    if (!snapshot.stale && edits.caughtUp()) setSourceChanged(false);
  });
  useEffect(() => {
    const events = new ProjectBuildEvents(projectId, snapshotArrived);
    buildEvents.current = events;
    return () => {
      events.close();
      buildEvents.current = null;
      compilation.current?.abort();
    };
  }, [projectId]);

  // A cheap key for the file tree's shape, recomputed only when nodes change.
  const structure = useMemo(() => structureKey(nodes), [nodes]);
  const previousStructure = useRef(structure);
  const structureChanged = useEffectEvent(() => {
    setSourceChanged(true);
    edits.report();
  });
  useEffect(() => {
    if (previousStructure.current === structure) return;
    previousStructure.current = structure;
    structureChanged();
  }, [structure]);

  async function compile(clean = false, auto = false) {
    if (!auto) {
      clearTimeout(autoCompileTimer.current);
      autoCompilePaused.current = false;
    }
    const snapshot = revision.current;
    const events = buildEvents.current;
    // Save first so the default save path persists even when compiling isn't possible.
    if (!canWrite || !(await saveSources()) || !main || !events) return;
    compilation.current?.abort();
    const startedAt = performance.now();
    const editedAt = lastEditAt.current;
    const controller = new AbortController();
    compilation.current = controller;
    setCompiling(true);
    setCompileError("");
    setCompileProblems([]);
    const sequence = edits.claim();
    try {
      const { sources, metadataVersion } = await sourceFiles();
      const result = await requestCompilation({
        projectId,
        events,
        clean,
        editorVersion: { editorId: edits.editorId, sequence },
        startedAt,
        lastEditAt: editedAt,
        mainFile: main,
        files: sources,
        metadataVersion,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10 * 60_000),
        ]),
        onPreview: ({ pdf, jobId, revision }) => {
          const build = { id: jobId, revision };
          if (
            !controller.signal.aborted &&
            isCurrentBuild(latestBuild.current, build)
          )
            shared.showPreview(build, pdf);
        },
      });
      if (controller.signal.aborted) return;
      if ("pdf" in result) {
        const build = { id: result.jobId, revision: result.revision };
        if (isCurrentBuild(latestBuild.current, build))
          shared.showCompiled(build, result.pdf);
        edits.acknowledge(sequence);
        setSourceChanged(revision.current !== snapshot);
      } else {
        setCompileError(result.error);
        if (result.limited) autoCompilePaused.current = true;
      }
      // The panel stays closed unless the user opens it.
      if (revision.current === snapshot)
        setCompileProblems(parseCompileLog(result.log, filenames, main));
    } catch (error) {
      if (controller.signal.aborted) return;
      setCompileError(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "The compile job is taking longer than expected. Try again in a few minutes."
          : error instanceof InvalidSourcePathError
            ? error.message
            : "The compiler could not be reached. Try again.",
      );
    } finally {
      if (compilation.current === controller) {
        compilation.current = null;
        setCompiling(false);
      }
    }
  }

  const runAutoCompile = useEffectEvent(() => {
    if (
      !afterIdle ||
      !canWrite ||
      !main ||
      autoCompilePaused.current ||
      blocked ||
      // Path policy errors persist until files are renamed; don't repeat them.
      invalidProjectPaths(nodes).length
    )
      return;
    if (saveInProgress()) {
      scheduleAutoCompile();
      return;
    }
    void compile(false, true);
  });
  function scheduleAutoCompile() {
    clearTimeout(autoCompileTimer.current);
    if (!afterIdle || !canWrite || autoCompilePaused.current) return;
    autoCompileTimer.current = setTimeout(runAutoCompile, afterIdle * 1000);
  }
  useEffect(() => {
    if (!afterIdle || !canWrite) clearTimeout(autoCompileTimer.current);
  }, [afterIdle, canWrite]);
  useEffect(() => () => clearTimeout(autoCompileTimer.current), []);

  /** Records an edit to a source; `local` edits schedule an auto-compile. */
  function recordEdit(local: boolean | undefined) {
    lastEditAt.current = performance.now();
    setSourceChanged(true);
    if (canWrite) edits.report();
    // Only this tab's edits schedule a build; peers compile their own.
    if (local) scheduleAutoCompile();
    setCompileProblems((current) => (current.length ? [] : current));
  }

  const stale = sourceChanged || (build?.stale ?? false);
  const status: CompileStatus =
    compiling ||
    build?.current?.status === "queued" ||
    build?.current?.status === "running"
      ? "Compiling…"
      : compileError || build?.current?.status === "failed"
        ? "Compile failed"
        : stale
          ? "Out of date"
          : shared.pdf
            ? "Up to date"
            : "Not compiled";
  return {
    build,
    stale,
    status,
    compiling,
    compileError,
    compileProblems,
    compile,
    recordEdit,
    pdf: shared.pdf,
    pdfBuildId: shared.pdfBuildId,
    pdfSaveState: shared.pdfSaveState,
  };
}

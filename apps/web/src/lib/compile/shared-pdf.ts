/** A compile job this tab ran, and the project revision it compiled. */
export type BuildRef = { id: string; revision: number | undefined };

/**
 * The PDF a workspace shows. A tab shows its own build as soon as it has one,
 * then switches to the shared artifact once the server has stored that build
 * (or a newer one). Other tabs only ever load the shared artifact.
 */
export type SharedPdfState = {
  pdf: File | null;
  /** The build this tab streamed a preview of, until the shared copy replaces it. */
  streamed: BuildRef | null;
  /** The build this tab compiled and is showing, until the shared copy replaces it. */
  completed: BuildRef | null;
  /** The shared artifact URL the displayed PDF matches. */
  displayedUrl: string | null;
};

export type SharedPdfAction =
  /** This tab streamed a preview of a build that is still running. */
  | { type: "preview"; build: BuildRef; pdf: File }
  /** This tab's build finished. */
  | { type: "compiled"; build: BuildRef; pdf: File }
  /** The shared artifact is the build already on screen. */
  | { type: "adopted"; url: string }
  /** The shared artifact was downloaded. */
  | { type: "loaded"; url: string; pdf: File }
  /** The project has no shared PDF. */
  | { type: "cleared" };

/** What the workspace should do to reconcile the state with the shared build. */
export type SharedPdfStep =
  | { kind: "keep" }
  | { kind: "adopt"; url: string }
  | { kind: "load"; url: string }
  | { kind: "clear" };

export const initialSharedPdf: SharedPdfState = {
  pdf: null,
  streamed: null,
  completed: null,
  displayedUrl: null,
};

export function sharedPdfReducer(
  state: SharedPdfState,
  action: SharedPdfAction,
): SharedPdfState {
  switch (action.type) {
    case "preview":
      return {
        ...state,
        pdf: action.pdf,
        streamed: action.build,
        completed: action.build,
      };
    case "compiled":
      return { ...state, pdf: action.pdf, completed: action.build };
    case "adopted":
      return state.displayedUrl === action.url
        ? state
        : { ...state, displayedUrl: action.url };
    case "loaded":
      return {
        pdf: action.pdf,
        streamed: null,
        completed: null,
        displayedUrl: action.url,
      };
    case "cleared":
      return isCleared(state) ? state : initialSharedPdf;
  }
}

function isCleared(state: SharedPdfState) {
  return (
    !state.pdf && !state.streamed && !state.completed && !state.displayedUrl
  );
}

const active = (build: BuildSnapshot | null, id: string) =>
  build?.current?.id === id &&
  (build.current.status === "queued" || build.current.status === "running");

/**
 * Decides how the shown PDF follows the shared build. This tab's own build
 * stays on screen while the server is still catching up to it, so a slower
 * snapshot never replaces a newer local PDF with an older shared one.
 */
export function sharedPdfStep(
  state: SharedPdfState,
  {
    build,
    sharedUrl,
    compiling,
  }: {
    build: BuildSnapshot | null;
    sharedUrl: string | null;
    compiling: boolean;
  },
): SharedPdfStep {
  const { completed } = state;
  if (completed) {
    // The streamed build is still being stored; the shared PDF is older.
    if (
      state.streamed?.id === completed.id &&
      build?.current &&
      build.artifacts?.id !== completed.id &&
      (build.artifacts?.revision ?? -1) <= (completed.revision ?? Infinity)
    )
      return { kind: "keep" };
    // A recovery read may deliver the PDF before the pushed snapshot catches up.
    if (
      (completed.revision !== undefined &&
        (build?.revision ?? -1) < completed.revision) ||
      active(build, completed.id)
    )
      return { kind: "keep" };
    if (build?.artifacts?.id === completed.id && sharedUrl)
      return state.displayedUrl === sharedUrl
        ? { kind: "keep" }
        : { kind: "adopt", url: sharedUrl };
  }
  if (!sharedUrl)
    return isCleared(state) ? { kind: "keep" } : { kind: "clear" };
  if (compiling || state.displayedUrl === sharedUrl) return { kind: "keep" };
  return { kind: "load", url: sharedUrl };
}

/**
 * Whether a build this tab requested is still the newest one, so its PDF may
 * be shown. A build superseded by a peer's newer build is discarded.
 */
export function isCurrentBuild(latest: BuildSnapshot | null, build: BuildRef) {
  return (
    latest?.current?.id === build.id ||
    (build.revision !== undefined &&
      (latest?.current?.revision ?? -1) <= build.revision)
  );
}

/** The build whose SyncTeX sidecar matches the PDF on screen. */
export function shownPdfBuildId(
  state: SharedPdfState,
  build: BuildSnapshot | null,
  sharedUrl: string | null,
) {
  if (state.streamed) return state.streamed.id;
  return state.pdf && sharedUrl && state.displayedUrl === sharedUrl
    ? (build?.artifacts?.id ?? null)
    : null;
}

/** Whether a streamed preview has been stored as the shared PDF yet. */
export function pdfSaveState(
  state: SharedPdfState,
  build: BuildSnapshot | null,
): "saved" | "saving" | "not-saved" {
  const { streamed } = state;
  if (!streamed || build?.artifacts?.id === streamed.id) return "saved";
  return active(build, streamed.id) ? "saving" : "not-saved";
}

export function sharedPdfFile(build: BuildSnapshot | null) {
  return build?.artifacts?.files.find(
    (file) => file.path === build.artifacts?.pdf,
  );
}
import { type BuildSnapshot } from "@texfolia/contracts";

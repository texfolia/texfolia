import { describe, expect, test } from "bun:test";

import type { BuildSnapshot } from "../build";
import {
  type BuildRef,
  initialSharedPdf,
  isCurrentBuild,
  pdfSaveState,
  sharedPdfReducer,
  sharedPdfStep,
  type SharedPdfState,
  shownPdfBuildId,
} from "./shared-pdf";

const local = { id: "local", revision: 3 } satisfies BuildRef;
const localPdf = new File(["local"], "output.pdf");
const sharedPdf = new File(["shared"], "output.pdf");
const sharedUrl = "/api/compile/p?file=out.pdf&version=k";

function snapshot({
  revision = 3,
  current,
  artifacts,
}: {
  revision?: number;
  current?: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
  };
  artifacts?: { id: string; revision: number };
}): BuildSnapshot {
  return {
    revision,
    stale: false,
    latestBuild: null,
    current: current ? { ...current, revision } : null,
    artifacts: artifacts
      ? {
          ...artifacts,
          digest: "d",
          builtAt: "",
          builtBy: "",
          engine: "pdflatex",
          pdf: "out.pdf",
          files: [{ path: "out.pdf", key: "k", sizeBytes: 1 }],
        }
      : null,
  };
}

const step = (
  state: SharedPdfState,
  build: BuildSnapshot | null,
  url: string | null = sharedUrl,
  compiling = false,
) => sharedPdfStep(state, { build, sharedUrl: url, compiling });

describe("shared PDF reducer", () => {
  test("a streamed preview is shown and remembered as this tab's build", () => {
    const state = sharedPdfReducer(initialSharedPdf, {
      type: "preview",
      build: local,
      pdf: localPdf,
    });
    expect(state).toEqual({
      pdf: localPdf,
      streamed: local,
      completed: local,
      displayedUrl: null,
    });
  });

  test("a finished build keeps any earlier streamed preview", () => {
    const streamed = sharedPdfReducer(initialSharedPdf, {
      type: "preview",
      build: local,
      pdf: localPdf,
    });
    const done = sharedPdfReducer(streamed, {
      type: "compiled",
      build: local,
      pdf: localPdf,
    });
    expect(done.streamed).toBe(local);
    expect(done.completed).toBe(local);
  });

  test("loading the shared PDF forgets the local build", () => {
    const state = sharedPdfReducer(
      { ...initialSharedPdf, pdf: localPdf, streamed: local, completed: local },
      { type: "loaded", url: sharedUrl, pdf: sharedPdf },
    );
    expect(state).toEqual({
      pdf: sharedPdf,
      streamed: null,
      completed: null,
      displayedUrl: sharedUrl,
    });
  });

  test("adopting keeps the local PDF and returns the same state when repeated", () => {
    const shown = { ...initialSharedPdf, pdf: localPdf, completed: local };
    const adopted = sharedPdfReducer(shown, {
      type: "adopted",
      url: sharedUrl,
    });
    expect(adopted.pdf).toBe(localPdf);
    expect(adopted.displayedUrl).toBe(sharedUrl);
    expect(sharedPdfReducer(adopted, { type: "adopted", url: sharedUrl })).toBe(
      adopted,
    );
  });

  test("clearing resets everything and is idempotent", () => {
    const cleared = sharedPdfReducer(
      {
        pdf: localPdf,
        streamed: local,
        completed: local,
        displayedUrl: sharedUrl,
      },
      { type: "cleared" },
    );
    expect(cleared).toBe(initialSharedPdf);
    expect(sharedPdfReducer(cleared, { type: "cleared" })).toBe(cleared);
  });
});

describe("shared PDF transitions", () => {
  test("a tab without its own build loads the shared PDF once", () => {
    const build = snapshot({ artifacts: { id: "peer", revision: 2 } });
    expect(step(initialSharedPdf, build)).toEqual({
      kind: "load",
      url: sharedUrl,
    });
    const loaded = sharedPdfReducer(initialSharedPdf, {
      type: "loaded",
      url: sharedUrl,
      pdf: sharedPdf,
    });
    expect(step(loaded, build)).toEqual({ kind: "keep" });
  });

  test("waits while this tab is compiling", () => {
    const build = snapshot({ artifacts: { id: "peer", revision: 2 } });
    expect(step(initialSharedPdf, build, sharedUrl, true)).toEqual({
      kind: "keep",
    });
  });

  test("clears when the project has no shared PDF", () => {
    const shown = {
      ...initialSharedPdf,
      pdf: sharedPdf,
      displayedUrl: sharedUrl,
    };
    expect(step(shown, snapshot({}), null)).toEqual({ kind: "clear" });
    expect(step(initialSharedPdf, snapshot({}), null)).toEqual({
      kind: "keep",
    });
  });

  test("keeps a streamed preview while the server stores it", () => {
    const streamed = sharedPdfReducer(initialSharedPdf, {
      type: "preview",
      build: local,
      pdf: localPdf,
    });
    const storing = snapshot({
      current: { id: "local", status: "succeeded" },
      artifacts: { id: "older", revision: 2 },
    });
    expect(step(streamed, storing)).toEqual({ kind: "keep" });
    // Also with no shared PDF yet: the preview is not cleared.
    expect(step(streamed, storing, null)).toEqual({ kind: "keep" });
  });

  test("keeps the local build while the snapshot is behind its revision", () => {
    const done = sharedPdfReducer(initialSharedPdf, {
      type: "compiled",
      build: local,
      pdf: localPdf,
    });
    const behind = snapshot({
      revision: 2,
      artifacts: { id: "older", revision: 2 },
    });
    expect(step(done, behind)).toEqual({ kind: "keep" });
  });

  test("keeps the local build while its job is still queued or running", () => {
    const done = sharedPdfReducer(initialSharedPdf, {
      type: "compiled",
      build: { id: "local", revision: undefined },
      pdf: localPdf,
    });
    for (const status of ["queued", "running"] as const)
      expect(
        step(done, snapshot({ current: { id: "local", status } }), null),
      ).toEqual({ kind: "keep" });
  });

  test("adopts the shared PDF once it is this tab's build, without downloading", () => {
    const done = sharedPdfReducer(initialSharedPdf, {
      type: "compiled",
      build: local,
      pdf: localPdf,
    });
    const stored = snapshot({
      current: { id: "local", status: "succeeded" },
      artifacts: { id: "local", revision: 3 },
    });
    expect(step(done, stored)).toEqual({ kind: "adopt", url: sharedUrl });
    const adopted = sharedPdfReducer(done, { type: "adopted", url: sharedUrl });
    expect(step(adopted, stored)).toEqual({ kind: "keep" });
    expect(adopted.pdf).toBe(localPdf);
  });

  test("a newer peer build replaces the local one", () => {
    const streamed = sharedPdfReducer(initialSharedPdf, {
      type: "preview",
      build: local,
      pdf: localPdf,
    });
    const newer = snapshot({
      revision: 4,
      current: { id: "peer", status: "succeeded" },
      artifacts: { id: "peer", revision: 4 },
    });
    expect(step(streamed, newer)).toEqual({ kind: "load", url: sharedUrl });
  });

  test("a failed local build falls back to clearing when nothing is shared", () => {
    const done = sharedPdfReducer(initialSharedPdf, {
      type: "compiled",
      build: local,
      pdf: localPdf,
    });
    const failed = snapshot({ current: { id: "local", status: "failed" } });
    expect(step(done, failed, null)).toEqual({ kind: "clear" });
  });
});

describe("shared PDF derived values", () => {
  test("only builds at or after the latest revision are current", () => {
    const latest = snapshot({
      revision: 3,
      current: { id: "peer", status: "running" },
    });
    expect(isCurrentBuild(latest, { id: "peer", revision: undefined })).toBe(
      true,
    );
    expect(isCurrentBuild(latest, { id: "mine", revision: 3 })).toBe(true);
    expect(isCurrentBuild(latest, { id: "mine", revision: 2 })).toBe(false);
    expect(isCurrentBuild(latest, { id: "mine", revision: undefined })).toBe(
      false,
    );
    expect(isCurrentBuild(null, { id: "mine", revision: 0 })).toBe(true);
  });

  test("reports whether a streamed preview has been stored", () => {
    const streamed = sharedPdfReducer(initialSharedPdf, {
      type: "preview",
      build: local,
      pdf: localPdf,
    });
    expect(pdfSaveState(initialSharedPdf, null)).toBe("saved");
    expect(
      pdfSaveState(
        streamed,
        snapshot({ current: { id: "local", status: "running" } }),
      ),
    ).toBe("saving");
    expect(
      pdfSaveState(
        streamed,
        snapshot({ current: { id: "local", status: "failed" } }),
      ),
    ).toBe("not-saved");
    expect(
      pdfSaveState(
        streamed,
        snapshot({ artifacts: { id: "local", revision: 3 } }),
      ),
    ).toBe("saved");
  });

  test("names the build behind the PDF on screen", () => {
    const build = snapshot({ artifacts: { id: "peer", revision: 2 } });
    const streamed = sharedPdfReducer(initialSharedPdf, {
      type: "preview",
      build: local,
      pdf: localPdf,
    });
    expect(shownPdfBuildId(streamed, build, sharedUrl)).toBe("local");
    const loaded = sharedPdfReducer(initialSharedPdf, {
      type: "loaded",
      url: sharedUrl,
      pdf: sharedPdf,
    });
    expect(shownPdfBuildId(loaded, build, sharedUrl)).toBe("peer");
    expect(shownPdfBuildId(loaded, build, "/other")).toBeNull();
    expect(shownPdfBuildId(initialSharedPdf, build, sharedUrl)).toBeNull();
  });
});

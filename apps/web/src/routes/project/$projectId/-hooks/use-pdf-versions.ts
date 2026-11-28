import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { pdfjs } from "react-pdf";

import { useStableCallback } from "#/hooks/use-stable-callback";
import { reportCompilePreview } from "#/lib/compile";
import { mapLimit } from "#/lib/map-limit";
import type { PageSize } from "#/lib/pdf/layout";

// How long a new version may take to draw before it shows anyway.
const replaceDelayMs = 2000;
const readConcurrency = 8;

export type PdfFile = string | File;

/** One version of the document. The next one loads behind the one that shows. */
export type PdfVersion = {
  id: number;
  file: PdfFile;
  ready?: { pdf: PDFDocumentProxy; sizes: PageSize[] };
  error?: string;
};

async function pageSize(
  pdf: PDFDocumentProxy,
  number: number,
): Promise<PageSize> {
  const page = await pdf.getPage(number);
  const { width, height } = page.getViewport({ scale: 1, rotation: 0 });
  return { width, height, rotation: page.rotate };
}

const sameSizes = (a: readonly PageSize[], b: readonly PageSize[]) =>
  a.length === b.length &&
  a.every(
    (size, index) =>
      size.width === b[index]?.width &&
      size.height === b[index].height &&
      size.rotation === b[index].rotation,
  );

/** Loads each new version of a document behind the one that shows. */
export function usePdfVersions(
  file: PdfFile,
  /** The page indexes that show. */
  visible: { first: number; last: number },
) {
  const [password, setPassword] = useState<{
    version: number;
    incorrect: boolean;
    phase: "asking" | "checking" | "cancelled";
    respond: (password: string) => void;
  }>();
  // The next version of a protected document likely has the same password.
  const lastPassword = useRef<string>(null);

  const [versions, setVersions] = useState<PdfVersion[]>(() => [
    { id: 0, file },
  ]);
  const latest = versions.at(-1);
  if (latest?.file !== file) {
    const shown = versions.find((version) => version.ready);
    setVersions([
      ...(shown ? [shown] : []),
      { id: (latest?.id ?? 0) + 1, file },
    ]);
  }
  const front = versions[0]?.ready ? versions[0] : undefined;
  const shown = front?.ready;
  // Until the latest version shows, SyncTeX describes other pages.
  const current = front?.file === file;

  function update(id: number, patch: Partial<PdfVersion>) {
    setVersions((previous) =>
      previous.map((version) =>
        version.id === id ? { ...version, ...patch } : version,
      ),
    );
  }
  /** Shows a version that loaded behind another one. */
  function replace(id: number) {
    setVersions((previous) => {
      const next = previous.find((version) => version.id === id);
      return next?.ready && previous.length > 1 ? [next] : previous;
    });
  }
  function failed(id: number, message: string) {
    setVersions((previous) => {
      const version = previous.find((version) => version.id === id);
      return version ? [{ id, file: version.file, error: message }] : previous;
    });
  }
  const loaded = useStableCallback(
    async (id: number, pdf: PDFDocumentProxy) => {
      try {
        const first = await pageSize(pdf, 1);
        // Most pages keep their size in the next version.
        const guess = Array.from({ length: pdf.numPages }, (_, index) =>
          index ? (shown?.sizes[index] ?? first) : first,
        );
        update(id, { ready: { pdf, sizes: guess } });
        const rest = await mapLimit(
          Array.from({ length: pdf.numPages - 1 }, (_, index) => index + 2),
          readConcurrency,
          (number) => pageSize(pdf, number),
        );
        const sizes = [first, ...rest];
        if (!sameSizes(sizes, guess)) update(id, { ready: { pdf, sizes } });
      } catch (error) {
        // A version that was replaced meanwhile has nothing left to read.
        console.error("The PDF's pages could not be read", error);
      }
    },
  );
  const loadFailed = useStableCallback((id: number, message: string) => {
    reportCompilePreview(file, "preview_failed");
    failed(id, message);
  });
  const passwordNeeded = useStableCallback(
    (id: number, respond: (password: string) => void, reason: number) => {
      const incorrect =
        reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD &&
        // A remembered password is a guess, not the reader's mistake.
        password?.version === id;
      if (reason === pdfjs.PasswordResponses.NEED_PASSWORD) {
        if (lastPassword.current !== null) {
          respond(lastPassword.current);
          return;
        }
      } else lastPassword.current = null;
      setPassword({ version: id, incorrect, phase: "asking", respond });
    },
  );
  const drawnPages = useRef(new Map<number, Set<number>>());
  const rendered = useStableCallback((id: number, page: number) => {
    if (id === latest?.id) reportCompilePreview(file, "rendered");
    if (id === front?.id) return;
    const done = drawnPages.current.get(id) ?? new Set();
    done.add(page);
    drawnPages.current.set(id, done);
    const count =
      versions.find((version) => version.id === id)?.ready?.sizes.length ?? 0;
    for (
      let index = Math.min(visible.first, count - 1);
      index <= Math.min(visible.last, count - 1);
      index++
    )
      if (!done.has(index + 1)) return;
    drawnPages.current.clear();
    replace(id);
  });
  const renderFailed = useStableCallback(() =>
    reportCompilePreview(file, "preview_failed"),
  );
  const waiting = versions.length > 1 && latest?.ready ? latest.id : undefined;
  const replaceWaiting = useStableCallback(replace);
  useEffect(() => {
    if (waiting === undefined) return;
    const timer = setTimeout(() => replaceWaiting(waiting), replaceDelayMs);
    return () => clearTimeout(timer);
  }, [waiting, replaceWaiting]);

  const asking = versions.some(({ id }) => id === password?.version)
    ? password
    : undefined;

  return {
    versions,
    front,
    shown,
    /** Whether the latest version shows. */
    current,
    load: loaded,
    fail: loadFailed,
    drawn: rendered,
    drawFailed: renderFailed,
    retry: (version: PdfVersion) =>
      setVersions([{ id: version.id + 1, file: version.file }]),
    askPassword: passwordNeeded,
    /** The password that is needed, if any. */
    password: asking && {
      version: asking.version,
      incorrect: asking.incorrect,
      phase: asking.phase,
      submit(value: string) {
        lastPassword.current = value;
        setPassword({ ...asking, phase: "checking" });
        asking.respond(value);
      },
      cancel: () => setPassword({ ...asking, phase: "cancelled" }),
      ask: () => setPassword({ ...asking, phase: "asking" }),
    },
  };
}

export type PdfVersions = ReturnType<typeof usePdfVersions>;

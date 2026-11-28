import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { printPdf } from "#/lib/pdf/print";
import { downloadFile } from "#/lib/storage/browser";

import type { PdfFile } from "./use-pdf-versions";

/** Downloads and prints the document. */
export function usePdfActions({
  file,
  filename,
  pdf,
}: {
  file: PdfFile;
  filename: string;
  pdf: PDFDocumentProxy | undefined;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState<{ page: number; of: number }>();
  const printAbort = useRef<AbortController>(null);

  async function download() {
    setDownloading(true);
    setError("");
    try {
      if (file instanceof File) downloadFile(file, filename);
      else {
        const response = await fetch(file);
        if (!response.ok) throw new Error("Download failed");
        downloadFile(await response.blob(), filename);
      }
    } catch {
      setError("Could not download the PDF. Try again.");
    } finally {
      setDownloading(false);
    }
  }
  async function print() {
    if (!pdf) return;
    const abort = new AbortController();
    printAbort.current?.abort();
    printAbort.current = abort;
    setError("");
    try {
      await printPdf(pdf, {
        signal: abort.signal,
        onProgress: (page) => setPrinting({ page, of: pdf.numPages }),
      });
    } catch {
      if (!abort.signal.aborted)
        setError(
          "Could not print the PDF. Download it to print it from another app.",
        );
    } finally {
      if (printAbort.current === abort) {
        printAbort.current = null;
        setPrinting(undefined);
      }
    }
  }
  useEffect(() => () => printAbort.current?.abort(), []);

  return {
    error,
    downloading,
    download: () => void download(),
    printing,
    print: () => void print(),
    cancelPrint: () => printAbort.current?.abort(),
  };
}

export type PdfActions = ReturnType<typeof usePdfActions>;

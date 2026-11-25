import type { PDFDocumentProxy } from "pdfjs-dist";

const printDpi = 200;
const pointsPerInch = 72;
// Browsers refuse larger canvases.
const maxPixels = 16 * 1024 * 1024;

let removePrevious = () => {};

/**
 * Prints every page. The pages are drawn as images into a hidden frame, because
 * the page's security policy allows no PDF plugin and some browsers have none.
 */
export async function printPdf(
  pdf: PDFDocumentProxy,
  {
    signal,
    onProgress,
  }: { signal: AbortSignal; onProgress: (page: number) => void },
) {
  removePrevious();
  const urls: string[] = [];
  const frame = document.createElement("iframe");
  frame.title = "Print preview";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Not `hidden`: some browsers print nothing from a frame that is not laid out.
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  const remove = () => {
    frame.remove();
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  };
  removePrevious = remove;
  try {
    document.body.appendChild(frame);
    const target = frame.contentWindow;
    if (!target) throw new Error("Printing is not available in this browser.");
    const style = target.document.createElement("style");
    for (let number = 1; number <= pdf.numPages; number++) {
      onProgress(number);
      const page = await pdf.getPage(number);
      signal.throwIfAborted();
      const size = page.getViewport({ scale: 1 });
      if (number === 1)
        style.textContent = `@page{size:${size.width}pt ${size.height}pt;margin:0}html,body{margin:0}img{display:block;width:100vw;height:100vh;object-fit:contain;break-after:page}img:last-child{break-after:auto}`;
      const viewport = page.getViewport({
        scale: Math.min(
          printDpi / pointsPerInch,
          Math.sqrt(maxPixels / (size.width * size.height)),
        ),
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport, intent: "print" }).promise;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve),
      );
      // Frees the bitmap now rather than when it is collected.
      canvas.width = 0;
      canvas.height = 0;
      signal.throwIfAborted();
      if (!blob) throw new Error("A page could not be prepared for printing.");
      const image = target.document.createElement("img");
      image.alt = `Page ${number}`;
      image.src = URL.createObjectURL(blob);
      urls.push(image.src);
      target.document.body.appendChild(image);
      await image.decode();
    }
    signal.throwIfAborted();
    target.document.head.appendChild(style);
    target.addEventListener("afterprint", remove, { once: true });
    target.focus();
    target.print();
  } catch (error) {
    remove();
    throw error;
  }
}

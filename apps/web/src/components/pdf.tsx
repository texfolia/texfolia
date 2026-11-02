import { Document, Page, pdfjs } from "react-pdf";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export default function PdfViewer() {
  return (
    <Document
      file="/sample.pdf"
      suspense={false}
      loading="Loading PDF…"
      error="Could not load PDF."
    >
      <Page pageNumber={1} width={600} />
    </Document>
  );
}

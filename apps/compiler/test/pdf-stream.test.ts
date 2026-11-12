import { expect, test } from "bun:test";

import { firstPdfPart } from "../src/pdf-stream";

const encoder = new TextEncoder();
const header =
  '--boundary\r\nContent-Disposition: form-data; name="pdf"; filename="output.pdf"\r\nContent-Type: application/pdf\r\n\r\n';
const tail =
  '\r\n--boundary\r\nContent-Disposition: form-data; name="log"\r\n\r\nok\r\n--boundary--\r\n';

test("PDF parser preserves binary bytes across every chunk size without reading the tail", async () => {
  const pdf = encoder.encode(
    "%PDF-1.5\n\u0000\u0001\u00ff\n\r\n--boundary-not-a-delimiter\n".repeat(20),
  );
  const bytes = new Uint8Array([
    ...encoder.encode(header),
    ...pdf,
    ...encoder.encode(tail),
  ]);
  for (const chunkSize of [1, 2, 7, 63, bytes.length]) {
    let offset = 0;
    let cancelled = false;
    let firstBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length)
          throw new Error("Read beyond PDF boundary");
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset = Math.min(offset + chunkSize, bytes.length);
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = await firstPdfPart(
      body,
      'multipart/form-data; boundary="boundary"',
      () => firstBytes++,
    );
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(
      pdf,
    );
    expect(cancelled).toBe(true);
    expect(firstBytes).toBe(1);
  }
});

test("PDF parser rejects missing headers, wrong ordering, empty PDFs and truncated bodies", async () => {
  for (const content of [
    "",
    header.replace('name="pdf"', 'name="log"'),
    "x".repeat(16_385),
  ]) {
    await expect(
      firstPdfPart(
        new Response(content).body!,
        "multipart/form-data; boundary=boundary",
        () => {},
      ),
    ).rejects.toThrow();
  }
  for (const content of [header + tail, header + "%PDF-truncated"]) {
    const stream = await firstPdfPart(
      new Response(content).body!,
      "multipart/form-data; boundary=boundary",
      () => {},
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
  }
});

// How far a viewer may fall behind before it reads the saved copy instead.
const maxLagBytes = 1024 * 1024;

/**
 * A PDF on its way to storage. A viewer that keeps up from the start receives
 * it as it arrives. Any other viewer continues from the saved copy, so no PDF
 * is ever held in memory for someone who may not read it.
 */
export class LivePdf {
  private written = 0;
  private state: "open" | "complete" | "failed" = "open";
  private saved = Promise.withResolvers<void>();
  private viewers = new Set<{
    write: (bytes: Uint8Array) => void;
    wake: () => void;
  }>();

  /** `open` reads the saved copy from an offset. */
  constructor(
    private open: (
      offset: number,
    ) => Promise<ReadableStream<Uint8Array> | null>,
  ) {
    this.saved.promise.catch(() => {});
  }

  write(bytes: Uint8Array) {
    this.written += bytes.byteLength;
    for (const viewer of this.viewers) viewer.write(bytes);
  }

  /** The whole PDF arrived. `saved` settles when storage has it, or never will. */
  complete(saved: Promise<unknown>) {
    this.state = "complete";
    saved.then(() => this.saved.resolve(), this.saved.reject);
    for (const viewer of this.viewers) viewer.wake();
  }

  fail(cause: unknown) {
    this.state = "failed";
    this.saved.reject(cause);
    for (const viewer of this.viewers) viewer.wake();
  }

  read(): ReadableStream<Uint8Array> {
    const queue: Uint8Array[] = [];
    let queued = 0;
    let sent = 0;
    let cancelled = false;
    // False once this viewer needs bytes that are no longer in memory.
    let live = this.written === 0;
    let saved: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let wake = () => {};
    const viewer = {
      write: (bytes: Uint8Array) => {
        if (!live) return;
        if (queued + bytes.byteLength > maxLagBytes) live = false;
        else {
          queued += bytes.byteLength;
          queue.push(bytes.slice());
        }
        wake();
      },
      wake: () => wake(),
    };
    this.viewers.add(viewer);
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (!cancelled) {
            const chunk = queue.shift();
            if (chunk) {
              queued -= chunk.byteLength;
              sent += chunk.byteLength;
              controller.enqueue(chunk);
              return;
            }
            if (live && this.state === "open") {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            // Rejects when the PDF never completed or could not be saved.
            if (!live || this.state === "failed") await this.saved.promise;
            if (sent < this.written && !saved) {
              const body = await this.open(sent);
              if (!body) throw new Error("The saved PDF is missing");
              saved = body.getReader();
              if (cancelled) await saved.cancel().catch(() => {});
            }
            const next = cancelled ? undefined : await saved?.read();
            if (cancelled) return;
            if (next?.value) controller.enqueue(next.value);
            else {
              this.viewers.delete(viewer);
              controller.close();
            }
            return;
          }
        },
        cancel: async () => {
          cancelled = true;
          this.viewers.delete(viewer);
          wake();
          await saved?.cancel();
        },
      },
      { highWaterMark: 0 },
    );
  }
}

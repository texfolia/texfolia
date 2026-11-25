import { expect, test } from "bun:test";

import { defaultFormatSettings, type FormatRequest } from "./format";
import { createLatexFormatter } from "./formatter";

function fakeWorker() {
  const requests: FormatRequest[] = [];
  const worker = {
    requests,
    terminated: false,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as (() => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: (data: FormatRequest) => void requests.push(data),
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

function setup() {
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const format = createLatexFormatter(() => {
    const worker = fakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { workers, format };
}

test("shares one worker and matches answers to requests", async () => {
  const { workers, format } = setup();
  const first = format("a", defaultFormatSettings);
  const second = format("b", defaultFormatSettings);
  expect(workers).toHaveLength(1);
  const [a, b] = workers[0]!.requests;
  workers[0]!.onmessage?.({ data: { id: b!.id, changes: [] } });
  workers[0]!.onmessage?.({ data: { id: a!.id, error: "No." } });
  expect(await second).toEqual([]);
  await expect(first).rejects.toThrow("No.");
});

for (const failure of ["onerror", "onmessageerror"] as const)
  test(`a worker that fails with ${failure} is terminated and replaced`, async () => {
    const { workers, format } = setup();
    const failed = format("a", defaultFormatSettings);
    workers[0]![failure]?.();
    await expect(failed).rejects.toThrow("The LaTeX formatter could not load.");
    expect(workers[0]!.terminated).toBe(true);
    const retried = format("a", defaultFormatSettings);
    expect(workers).toHaveLength(2);
    workers[1]!.onmessage?.({
      data: { id: workers[1]!.requests[0]!.id, changes: [] },
    });
    expect(await retried).toEqual([]);
  });

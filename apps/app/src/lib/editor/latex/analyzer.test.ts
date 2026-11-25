import { expect, test } from "bun:test";

import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  emptyAnalysis,
} from "./analysis";
import { LatexAnalyzer } from "./analyzer";
import { emptyWordCount } from "./word-count";

function setup() {
  const workers: {
    requests: AnalyzeRequest[];
    terminated: boolean;
    onmessage: ((event: { data: AnalyzeResponse }) => void) | null;
    onerror: (() => void) | null;
  }[] = [];
  const analyzer = new LatexAnalyzer(() => {
    const worker = {
      requests: [] as AnalyzeRequest[],
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage: (data: AnalyzeRequest) => void worker.requests.push(data),
      terminate() {
        worker.terminated = true;
      },
    };
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const results: number[] = [];
  analyzer.open(({ revision }) => results.push(revision));
  const answer = (revision: number) =>
    workers.at(-1)!.onmessage?.({
      data: { revision, analysis: emptyAnalysis, words: emptyWordCount },
    });
  return { analyzer, workers, results, answer };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("adding, renaming and removing files keeps the worker", () => {
  const { analyzer, workers } = setup();
  analyzer.update("main.tex", "main");
  analyzer.setProject(["main.tex"], "main.tex");
  analyzer.setProject(["main.tex", "a.tex"], "main.tex");
  analyzer.setProject(["main.tex", "b.tex"], "main.tex");
  analyzer.setProject(["main.tex"], "main.tex");
  expect(workers).toHaveLength(1);
  expect(workers[0]!.terminated).toBe(false);
  expect(workers[0]!.requests.map(({ updates }) => updates)).toEqual([
    [["main.tex", "main"]],
    [],
    [],
    [],
  ]);
  expect(workers[0]!.requests.map(({ paths }) => paths.length)).toEqual([
    1, 2, 2, 1,
  ]);
});

test("text reported before its path, or of a restored path, is sent with it", () => {
  const { analyzer, workers } = setup();
  analyzer.setProject(["main.tex"], "main.tex");
  analyzer.update("new.tex", "new");
  analyzer.setProject(["main.tex", "new.tex"], "main.tex");
  analyzer.setProject(["main.tex"], "main.tex");
  analyzer.setProject(["main.tex", "new.tex"], "main.tex");
  expect(workers[0]!.requests.map(({ updates }) => updates)).toEqual([
    [],
    [["new.tex", "new"]],
    [],
    [["new.tex", "new"]],
  ]);
});

test("batches edits and drops answers to earlier text", async () => {
  const { analyzer, workers, results, answer } = setup();
  analyzer.setProject(["main.tex"], "main.tex");
  analyzer.update("main.tex", "a");
  analyzer.update("main.tex", "ab");
  expect(workers[0]!.requests).toHaveLength(1);
  await wait(300);
  expect(workers[0]!.requests[1]).toMatchObject({
    revision: 2,
    updates: [["main.tex", "ab"]],
  });
  answer(1);
  answer(2);
  expect(results).toEqual([2]);
});

test("a failed worker is replaced with every file's text", () => {
  const { analyzer, workers } = setup();
  analyzer.update("main.tex", "main");
  analyzer.setProject(["main.tex"], "main.tex");
  workers[0]!.onerror?.();
  expect(workers[0]!.terminated).toBe(true);
  analyzer.setProject(["main.tex", "a.tex"], "main.tex");
  expect(workers).toHaveLength(2);
  expect(workers[1]!.requests[0]!.updates).toEqual([["main.tex", "main"]]);
});

test("closing stops the worker and reopening starts another", () => {
  const { analyzer, workers, results } = setup();
  analyzer.update("main.tex", "main");
  analyzer.setProject(["main.tex"], "main.tex");
  analyzer.close();
  expect(workers[0]!.terminated).toBe(true);
  workers[0]!.onmessage?.({
    data: { revision: 1, analysis: emptyAnalysis, words: emptyWordCount },
  });
  expect(results).toEqual([]);
  analyzer.open(() => {});
  analyzer.setProject(["main.tex"], "main.tex");
  expect(workers[1]!.requests[0]!.updates).toEqual([["main.tex", "main"]]);
});

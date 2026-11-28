import type {
  FormatChange,
  FormatRequest,
  FormatResponse,
  FormatSettings,
} from "@texfolia/editor";

import { createWorkerClient } from "#/lib/worker-client";

import { createFormatWorker } from "./workers";

export type LatexFormatter = (
  source: string,
  settings: FormatSettings,
) => Promise<FormatChange[]>;

export function createLatexFormatter(
  createWorker: () => Worker,
): LatexFormatter {
  const request = createWorkerClient<FormatRequest, FormatResponse>(
    createWorker,
    "The LaTeX formatter could not load.",
  );
  return async (source, settings) => {
    const response = await request({ source, settings });
    if ("error" in response) throw new Error(response.error);
    return response.changes;
  };
}

let shared: LatexFormatter | undefined;

/** The browser's formatter: one worker for every tab, started on first use. */
export function browserLatexFormatter() {
  return (shared ??= createLatexFormatter(createFormatWorker));
}

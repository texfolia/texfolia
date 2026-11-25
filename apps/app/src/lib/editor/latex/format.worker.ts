import { TexFmt } from "wasm-latex-tools";

import {
  formatChanges,
  type FormatRequest,
  type FormatResponse,
} from "./format";
import { latexToolsPath } from "./tools";

const formatter = new TexFmt(
  false,
  new URL(
    `${import.meta.env.BASE_URL}${latexToolsPath}/texfmt`,
    self.location.origin,
  ).href,
);

async function respond({
  id,
  source,
  settings,
}: FormatRequest): Promise<FormatResponse> {
  try {
    const result = await formatter.format({
      input: source,
      tabsize: settings.indent,
      wrap: settings.wrap,
      wraplen: settings.width,
      usetabs: false,
    });
    if (!result.success)
      throw new Error(result.error ?? "Could not format LaTeX.");
    return { id, changes: formatChanges(source, result.output) };
  } catch (error) {
    return {
      id,
      error: error instanceof Error ? error.message : "Could not format LaTeX.",
    };
  }
}

// Every editor tab shares this worker; its documents are formatted in turn.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<FormatRequest>) => {
  queue = queue.then(async () => self.postMessage(await respond(data)));
};

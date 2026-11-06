import { TexFmt } from "wasm-latex-tools";

import {
  formatChanges,
  type FormatResponse,
  type FormatSettings,
} from "./format";

const formatter = new TexFmt(
  false,
  new URL(`${import.meta.env.BASE_URL}core/texfmt`, self.location.origin).href,
);
self.onmessage = async ({
  data,
}: MessageEvent<{ source: string; settings: FormatSettings }>) => {
  let response: FormatResponse;
  try {
    const { source, settings } = data;
    const result = await formatter.format({
      input: source,
      tabsize: settings.indent,
      wrap: settings.wrap,
      wraplen: settings.width,
      usetabs: false,
    });
    if (!result.success)
      throw new Error(result.error ?? "Could not format LaTeX.");
    response = { changes: formatChanges(source, result.output) };
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : "Could not format LaTeX.",
    };
  }
  self.postMessage(response);
};

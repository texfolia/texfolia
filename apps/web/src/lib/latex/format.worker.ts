import {
  formatChanges,
  type FormatResponse,
  type FormatSettings,
} from "./format";
import init, { main } from "./vendor/tex-fmt/tex_fmt.js";
import wasm from "./vendor/tex-fmt/tex_fmt_bg.wasm?url";

const ready = init({ module_or_path: wasm });
self.onmessage = async ({
  data,
}: MessageEvent<{ source: string; settings: FormatSettings }>) => {
  let response: FormatResponse;
  try {
    await ready;
    const { source, settings } = data;
    const config = `tabsize = ${settings.indent}\nwrap = ${settings.wrap}\nwraplen = ${settings.width}`;
    response = { changes: formatChanges(source, main(source, config).output) };
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : "Could not format LaTeX.",
    };
  }
  self.postMessage(response);
};

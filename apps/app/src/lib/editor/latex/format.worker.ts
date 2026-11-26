import {
  formatChanges,
  type FormatRequest,
  type FormatResponse,
} from "@texfolia/editor";
import { formatLatex } from "@texfolia/tex-fmt";

async function respond({
  id,
  source,
  settings,
}: FormatRequest): Promise<FormatResponse> {
  try {
    const result = await formatLatex(source, {
      tabsize: settings.indent,
      wrap: settings.wrap,
      wraplen: settings.width,
      usetabs: false,
    });
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

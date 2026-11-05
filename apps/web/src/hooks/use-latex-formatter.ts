import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FormatResponse, FormatSettings } from "#/lib/latex/format";

export function useLatexFormatter(settings: FormatSettings) {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(false);
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState("");

  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
      pending.current = false;
    },
    [],
  );

  const format = useCallback(
    (view: EditorView) => {
      if (pending.current) return true;
      const instance =
        worker.current ??
        new Worker(new URL("../lib/latex/format.worker.ts", import.meta.url), {
          type: "module",
        });
      worker.current = instance;
      const document = view.state.doc;
      pending.current = true;
      setFormatting(true);
      setFormatError("");
      function finish(error = "") {
        pending.current = false;
        setFormatting(false);
        setFormatError(error);
      }
      instance.onerror = () => {
        instance.terminate();
        worker.current = null;
        finish("The LaTeX formatter could not load.");
      };
      instance.onmessage = ({ data }: MessageEvent<FormatResponse>) => {
        if ("error" in data) return finish(data.error);
        if (document !== view.state.doc)
          return finish(
            "The document changed while formatting. Run the command again.",
          );
        if (data.changes.length)
          view.dispatch({
            changes: data.changes,
            annotations: isolateHistory.of("full"),
            userEvent: "input.format",
          });
        finish();
      };
      instance.postMessage({ source: document.toString(), settings });
      return true;
    },
    [settings],
  );

  return { format, formatting, formatError };
}

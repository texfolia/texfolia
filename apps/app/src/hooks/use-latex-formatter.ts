import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FormatChange, FormatSettings } from "#/lib/editor/latex/format";
import { browserLatexFormatter } from "#/lib/editor/latex/formatter";

export function useLatexFormatter(settings: FormatSettings) {
  const pending = useRef(false);
  const mounted = useRef(false);
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current = false;
    };
  }, []);

  const format = useCallback(
    (view: EditorView) => {
      if (pending.current) return true;
      const document = view.state.doc;
      pending.current = true;
      setFormatting(true);
      setFormatError("");
      function finish(error = "") {
        if (!mounted.current) return;
        pending.current = false;
        setFormatting(false);
        setFormatError(error);
      }
      function apply(changes: FormatChange[]) {
        if (!mounted.current || !view.dom.isConnected) return finish();
        if (document !== view.state.doc)
          return finish(
            "The document changed while formatting. Run the command again.",
          );
        if (changes.length)
          view.dispatch({
            changes,
            annotations: isolateHistory.of("full"),
            userEvent: "input.format",
          });
        finish();
      }
      browserLatexFormatter()(document.toString(), settings)
        .then(apply)
        .catch((error: unknown) =>
          finish(
            error instanceof Error ? error.message : "Could not format LaTeX.",
          ),
        );
      return true;
    },
    [settings],
  );

  return { format, formatting, formatError };
}

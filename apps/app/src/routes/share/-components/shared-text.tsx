import CodeMirror, { EditorState } from "@uiw/react-codemirror";
import { cn } from "cn";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useEditorTheme } from "#/hooks/use-editor-theme";
import { CollaborativeFile } from "#/lib/collaboration/browser";
import { bibtexLanguage, themedLatex } from "#/lib/editor/latex/highlight";
import { markdownSupport } from "#/lib/editor/markdown";
import { withShareToken } from "#/lib/sharing/share-token";
import { extensionOf } from "#/lib/storage/extension";

import type { SharedNode } from "./shared-project-view";

export function SharedText({
  projectId,
  node,
  token,
}: {
  projectId: string;
  node: SharedNode;
  token: string;
}) {
  const theme = useEditorTheme();
  const [value, setValue] = useState("");
  // Follow live edits through the collaboration room, read-only.
  const [file] = useState(
    () =>
      new CollaborativeFile({
        projectId,
        nodeId: node.id,
        userId: "share-guest",
        canWrite: false,
        anonymous: true,
        decorateUrl: (url) => withShareToken(url, token),
        onChange: setValue,
      }),
  );
  useEffect(() => () => file.destroy(), [file]);
  const status = useSyncExternalStore(file.subscribe, file.getStatus);
  const extensions = useMemo(() => {
    const extension = extensionOf(node.name);
    const language = ["tex", "ltx", "sty", "cls"].includes(extension)
      ? [themedLatex(node.name)]
      : extension === "md"
        ? [markdownSupport()]
        : extension === "bib"
          ? [bibtexLanguage]
          : [];
    return [EditorState.readOnly.of(true), ...language];
  }, [node.name]);
  if (!status.ready)
    return (
      <p
        role={status.error ? "alert" : "status"}
        className={cn("p-3 text-sm", status.error && "text-destructive")}
      >
        {status.error || "Loading source…"}
      </p>
    );
  return (
    <>
      {status.error && (
        <p role="alert" className="text-destructive border-b px-2 py-1 text-xs">
          {status.error}
        </p>
      )}
      <CodeMirror
        value={value}
        extensions={extensions}
        readOnly
        height="100%"
        theme={theme}
        aria-label={`${node.name} source, read only`}
        className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
      />
    </>
  );
}

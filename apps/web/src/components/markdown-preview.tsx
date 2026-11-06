import { Markdown } from "@tanstack/markdown/react";
import type { IDockviewPanelProps } from "dockview-react";

export type MarkdownPreviewParams = { source: string };

export function MarkdownPreview({
  params,
}: IDockviewPanelProps<MarkdownPreviewParams>) {
  return (
    <section
      aria-label="Markdown preview"
      tabIndex={0}
      className="bg-background h-full overflow-auto"
    >
      <article className="typeset mx-auto max-w-3xl p-6 sm:p-8">
        <Markdown>{params.source}</Markdown>
      </article>
    </section>
  );
}

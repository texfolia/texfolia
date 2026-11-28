import { Markdown } from "@tanstack/markdown/react";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo } from "react";

import { ImagePreview } from "#/components/image-preview";
import { scratchpadId } from "#/lib/collaboration";
import { renderPlainTextMentions } from "#/lib/mentions/tokens";
import { imageType } from "#/lib/storage/preview";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

export type MarkdownPreviewParams = { source: string };

/** An image kept as text, which is SVG. Shown as an image, it runs no scripts. */
function SourceImage({ name, source }: { name: string; source: string }) {
  const file = useMemo(
    () => new File([source], name, { type: imageType(name) }),
    [name, source],
  );
  return <ImagePreview file={file} />;
}

export function MarkdownPreview({
  api,
  params,
}: IDockviewPanelProps<MarkdownPreviewParams>) {
  // Follow live edits, even after the file's own tab closes.
  const { holdDocument } = useWorkspaceActions();
  const nodeId = api.id.slice("markdown:".length);
  useEffect(() => holdDocument(nodeId), [holdDocument, nodeId]);
  const { paths, mentionCandidates } = useWorkspace();
  const name = paths.get(nodeId)?.split("/").at(-1);
  const renderedSource = useMemo(() => {
    if (nodeId !== scratchpadId) return params.source;
    const byId = new Map(
      mentionCandidates.map((person) => [person.id, person.name]),
    );
    return renderPlainTextMentions(
      params.source,
      (userId, fallbackName) => byId.get(userId) ?? fallbackName,
    );
  }, [nodeId, params.source, mentionCandidates]);
  if (name && imageType(name))
    return <SourceImage name={name} source={params.source} />;
  return (
    <section
      aria-label="Markdown preview"
      tabIndex={0}
      className="bg-background h-full overflow-auto"
    >
      <article className="[&_pre]:bg-muted [&_blockquote]:text-muted-foreground [&_input]:accent-primary mx-auto max-w-3xl p-6 text-base leading-7 wrap-anywhere sm:p-8 [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_blockquote]:my-6 [&_blockquote]:border-l [&_blockquote]:pl-4 [&_code]:font-mono [&_code]:text-sm [&_h1]:mt-8 [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:mb-3 [&_h3]:text-xl [&_h3]:font-medium [&_h4]:mt-5 [&_h4]:font-medium [&_h5]:mt-4 [&_h5]:font-medium [&_h6]:mt-4 [&_h6]:text-sm [&_h6]:font-medium [&_hr]:my-8 [&_img]:my-4 [&_img]:h-auto [&_img]:max-w-full [&_li]:my-1 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:p-4 [&_pre]:text-sm [&_strong]:font-semibold [&_sub]:text-xs [&_sup]:text-xs [&_table]:my-6 [&_table]:w-full [&_table]:text-sm [&_table]:tabular-nums [&_td]:border-b [&_td]:p-2 [&_th]:border-b [&_th]:p-2 [&_th]:text-left [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&>:first-child]:mt-0">
        <Markdown>{renderedSource}</Markdown>
      </article>
    </section>
  );
}

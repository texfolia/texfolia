import { type InferPageType, loader } from "fumadocs-core/source";
import { llms } from "fumadocs-core/source/llms";
import { docs } from "fumadocs-mdx:collections/server";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});

export type DocsPage = InferPageType<typeof source>;

export function getPageMarkdownUrl(url: string): string {
  const slug = url.replace(/^\/+|\/+$/g, "");
  return slug ? `/llms.mdx/${slug}.md` : "/llms.mdx/index.md";
}

export async function getLLMText(page: DocsPage): Promise<string> {
  const processed = await page.data.getText("processed");
  return `# ${page.data.title} (${page.url})\n\n${processed}`;
}

export const docsLlms = llms(source, {
  renderPage: getLLMText,
  renderUrl: (item) => getPageMarkdownUrl(item.url),
});

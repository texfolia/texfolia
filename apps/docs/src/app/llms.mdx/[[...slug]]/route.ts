import { notFound } from "next/navigation";

import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug = [] } = await params;
  const cleaned = [...slug];
  const last = cleaned.at(-1);
  if (last?.endsWith(".md")) {
    cleaned[cleaned.length - 1] = last.slice(0, -3);
  }
  const lookup = cleaned.length === 1 && cleaned[0] === "index" ? [] : cleaned;

  const page = source.getPage(lookup);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => {
    if (page.slugs.length === 0) {
      return { slug: ["index.md"] };
    }
    const slug = [...page.slugs];
    slug[slug.length - 1] = `${slug.at(-1)}.md`;
    return { slug };
  });
}

/** Markdown without its fenced code. */
export function withoutFences(markdown) {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

/**
 * The fragments that reach a Markdown file's headings and anchors, as GitHub and
 * Starlight name them.
 */
export function headingIds(markdown) {
  const ids = new Set(["_top"]);
  const body = withoutFences(markdown).replace(/^---\n[\s\S]*?\n---\n/, "");
  for (const [, id] of body.matchAll(/\sid="([^"]+)"/g)) ids.add(id);
  const used = new Map();
  for (const [, heading] of body.matchAll(
    /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
  )) {
    const slug = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replaceAll(" ", "-");
    const count = used.get(slug) ?? 0;
    used.set(slug, count + 1);
    ids.add(count ? `${slug}-${count}` : slug);
  }
  return ids;
}

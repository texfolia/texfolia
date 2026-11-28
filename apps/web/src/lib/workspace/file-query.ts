/** Splits `chapter.tex:12:3` into what to find and where to go. */
export function parseFileQuery(query: string) {
  const match = /^(.*?):(\d+)?(?::(\d+)?)?$/.exec(query.trim());
  return {
    text: match?.[1] ?? query.trim(),
    line: match?.[2] ? Number(match[2]) : undefined,
    column: match?.[3] ? Number(match[3]) : undefined,
  };
}

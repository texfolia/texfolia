const defaultDescription =
  "Write LaTeX, work together in real time, and turn your source into a finished PDF in one browser workspace.";

/** Route `head` for a marketing page. */
export function pageHead({
  title,
  description = defaultDescription,
  robots,
}: {
  title: string;
  description?: string;
  robots?: string;
}) {
  return {
    meta: [
      { title },
      { name: "description", content: description },
      ...(robots ? [{ name: "robots", content: robots }] : []),
    ],
  };
}

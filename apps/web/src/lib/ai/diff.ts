import { diffLines, diffWordsWithSpace } from "diff";

export type DiffLine = {
  kind: "same" | "removed" | "added";
  parts: { text: string; changed: boolean }[];
};

// Comparing the words of longer passages takes too long to be worth it.
const maxWordDiff = 4000;

const lines = (text: string) => {
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
};

/** Cuts parts of a passage into its lines. */
function partLines(
  kind: DiffLine["kind"],
  parts: readonly { text: string; changed: boolean }[],
): DiffLine[] {
  const result: DiffLine[] = [{ kind, parts: [] }];
  for (const { text, changed } of parts)
    for (const [index, line] of text.split("\n").entries()) {
      if (index) result.push({ kind, parts: [] });
      if (line) result.at(-1)?.parts.push({ text: line, changed });
    }
  // A final line break ends a line; it does not start another.
  if (result.length > 1 && !result.at(-1)?.parts.length) result.pop();
  return result;
}

const whole = (kind: DiffLine["kind"], text: string): DiffLine[] =>
  lines(text).map((line) => ({
    kind,
    parts: line ? [{ text: line, changed: false }] : [],
  }));

/** The lines of a replacement, marking the words that changed in them. */
export function diffReplacement(oldText: string, newText: string): DiffLine[] {
  const result: DiffLine[] = [];
  const changes = diffLines(oldText, newText);
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    const next = changes[index + 1];
    if (!change.added && !change.removed)
      result.push(...whole("same", change.value));
    else if (
      change.removed &&
      next?.added &&
      change.value.length + next.value.length <= maxWordDiff
    ) {
      const words = diffWordsWithSpace(change.value, next.value);
      const side = (kind: "removed" | "added") =>
        partLines(
          kind,
          words
            .filter((word) =>
              kind === "removed" ? !word.added : !word.removed,
            )
            .map((word) => ({ text: word.value, changed: !!word[kind] })),
        );
      result.push(...side("removed"), ...side("added"));
      index++;
    } else
      result.push(...whole(change.added ? "added" : "removed", change.value));
  }
  return result;
}

export function diffCounts(diff: readonly DiffLine[]) {
  return {
    added: diff.filter(({ kind }) => kind === "added").length,
    removed: diff.filter(({ kind }) => kind === "removed").length,
  };
}

import { diffArrays } from "diff";

export type FormatSettings = { indent: number; wrap: boolean; width: number };
export const defaultFormatSettings: FormatSettings = {
  indent: 2,
  wrap: true,
  width: 80,
};
export type FormatChange = { from: number; to: number; insert: string };
export type FormatResponse = { changes: FormatChange[] } | { error: string };

export function formatChanges(
  source: string,
  formatted: string,
): FormatChange[] {
  if (source === formatted) return [];
  const before = source.match(/\s+|\S/gu) ?? [];
  const after = formatted.match(/\s+|\S/gu) ?? [];
  // Treat whitespace runs as anchors even when indentation or line breaks change.
  // This keeps a large reindent from becoming one large character diff.
  const parts = diffArrays(before, after, {
    comparator: (left, right) =>
      left === right || (/^\s/.test(left) && /^\s/.test(right)),
    timeout: 1500,
  });
  if (!parts) throw new Error("Too many formatting changes to apply safely.");

  const changes: FormatChange[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let position = 0;

  function add(from: number, to: number, insert: string) {
    const previous = changes.at(-1);
    if (previous?.to === from) {
      previous.to = to;
      previous.insert += insert;
    } else {
      changes.push({ from, to, insert });
    }
  }

  for (const part of parts) {
    if (part.added) {
      add(position, position, part.value.join(""));
      newIndex += part.value.length;
    } else if (part.removed) {
      const to =
        position +
        part.value.reduce((length, token) => length + token.length, 0);
      add(position, to, "");
      position = to;
      oldIndex += part.value.length;
    } else {
      for (let i = 0; i < part.value.length; i++) {
        const oldToken = before[oldIndex++] ?? "";
        const newToken = after[newIndex++] ?? "";
        if (oldToken !== newToken) {
          let start = 0;
          let end = 0;
          while (
            start < Math.min(oldToken.length, newToken.length) &&
            oldToken[start] === newToken[start]
          )
            start++;
          while (
            end < Math.min(oldToken.length, newToken.length) - start &&
            oldToken[oldToken.length - 1 - end] ===
              newToken[newToken.length - 1 - end]
          )
            end++;
          add(
            position + start,
            position + oldToken.length - end,
            newToken.slice(start, newToken.length - end),
          );
        }
        position += oldToken.length;
      }
    }
  }
  return changes;
}

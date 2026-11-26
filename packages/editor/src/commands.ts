import { EditorSelection, type StateCommand } from "@codemirror/state";

function closingBrace(source: string, from: number) {
  let depth = 1;
  for (let index = from; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return undefined;
}

export function toggleLatexCommand(
  command: "textbf" | "textit" | "underline",
): StateCommand {
  return ({ state, dispatch }) => {
    const prefix = `\\${command}{`;
    dispatch(
      state.update(
        state.changeByRange((range) => {
          const text = state.sliceDoc(range.from, range.to);
          const surrounding =
            state.sliceDoc(
              Math.max(0, range.from - prefix.length),
              range.from,
            ) === prefix && state.sliceDoc(range.to, range.to + 1) === "}";
          if (surrounding)
            return {
              changes: [
                {
                  from: range.from - prefix.length,
                  to: range.from,
                  insert: "",
                },
                { from: range.to, to: range.to + 1, insert: "" },
              ],
              range: EditorSelection.range(
                range.anchor - prefix.length,
                range.head - prefix.length,
              ),
            };
          if (
            text.startsWith(prefix) &&
            closingBrace(text, prefix.length) === text.length - 1
          ) {
            const content = text.slice(prefix.length, -1);
            return {
              changes: { from: range.from, to: range.to, insert: content },
              range: EditorSelection.range(
                range.from,
                range.from + content.length,
              ),
            };
          }
          return {
            changes: {
              from: range.from,
              to: range.to,
              insert: `${prefix}${text}}`,
            },
            range: EditorSelection.range(
              range.anchor + prefix.length,
              range.head + prefix.length,
            ),
          };
        }),
        { userEvent: "input.format" },
      ),
    );
    return true;
  };
}

export const headingCommands = [
  "",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "subparagraph*",
] as const;

export function applyLatexHeading(
  command: (typeof headingCommands)[number],
): StateCommand {
  return ({ state, dispatch }) => {
    const lines = new Set<number>();
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(
        range.to > range.from ? range.to - 1 : range.to,
      ).number;
      for (let line = first; line <= last; line++) lines.add(line);
    }
    const changes = [...lines]
      .sort((a, b) => a - b)
      .map((number) => {
        const line = state.doc.line(number);
        const indent = line.text.match(/^\s*/)?.[0] ?? "";
        const text = line.text.trimStart();
        const prefix =
          text.match(
            /^\\(?:section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/,
          )?.[0] ?? "";
        const close = prefix ? closingBrace(text, prefix.length) : undefined;
        const isHeading =
          close !== undefined && text.slice(close + 1).trim() === "";
        const content = isHeading ? text.slice(prefix.length, close) : text;
        const contentFrom =
          line.from + indent.length + (isHeading ? prefix.length : 0);
        return {
          from: line.from,
          to: line.to,
          insert: indent + (command ? `\\${command}{${content}}` : content),
          contentFrom,
          contentLength: content.length,
          contentOffset: indent.length + (command ? command.length + 2 : 0),
        };
      });
    const changeSet = state.changes(changes);
    function mapPosition(position: number) {
      const change = changes.find(
        ({ from, to }) => position >= from && position <= to,
      );
      if (!change) return changeSet.mapPos(position);
      return (
        changeSet.mapPos(change.from, -1) +
        change.contentOffset +
        Math.max(
          0,
          Math.min(change.contentLength, position - change.contentFrom),
        )
      );
    }
    dispatch(
      state.update({
        changes: changeSet,
        selection: EditorSelection.create(
          state.selection.ranges.map((range) =>
            EditorSelection.range(
              mapPosition(range.anchor),
              mapPosition(range.head),
            ),
          ),
          state.selection.mainIndex,
        ),
        userEvent: "input.format",
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

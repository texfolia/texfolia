import {
  commonmarkLanguage,
  markdownKeymap,
  pasteURLAsLink,
} from "@codemirror/lang-markdown";
import { foldService, LanguageSupport, syntaxTree } from "@codemirror/language";
import { type Extension, keymap, Prec } from "@uiw/react-codemirror";

function headingLevel(name: string) {
  const match = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
  return match ? Number(match[1]) : undefined;
}

// Folds a heading's section. lang-markdown has this too but does not export it.
const foldSections = foldService.of((state, start, end) => {
  for (
    let node = syntaxTree(state).resolveInner(end, -1);
    node.parent && node.from >= start;
    node = node.parent
  ) {
    const level = headingLevel(node.name);
    if (level === undefined) continue;
    let last = node;
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      const nextLevel = headingLevel(next.name);
      if (nextLevel !== undefined && nextLevel <= level) break;
      last = next;
    }
    if (last.to > end) return { from: end, to: last.to };
  }
  return null;
});

/**
 * Markdown editing without `markdown()` from lang-markdown, which always loads
 * the HTML, CSS and JavaScript languages for raw HTML blocks.
 */
export function markdownSupport(): Extension {
  return new LanguageSupport(commonmarkLanguage, [
    foldSections,
    pasteURLAsLink,
    Prec.high(keymap.of(markdownKeymap)),
  ]);
}

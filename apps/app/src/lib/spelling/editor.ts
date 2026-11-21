import { type Diagnostic, forEachDiagnostic, linter } from "@codemirror/lint";
import { EditorView, StateEffect } from "@uiw/react-codemirror";

import type { SpellChecker } from "./checker";
import { spellingDictionaries, type SpellingDictionary } from "./languages";
import { proseWords } from "./prose";

/** Dispatch after the personal dictionary changes to check again. */
export const personalDictionaryChanged = StateEffect.define<void>();

export type SpellcheckOptions = {
  language: SpellingDictionary;
  checker: SpellChecker;
  /** Whether the personal dictionary accepts a word. */
  isKnown: (word: string) => boolean;
  /** Adds a word to the personal dictionary; omitted for read-only editors. */
  addWord?: (word: string) => void;
  /** Called with a message when the dictionary fails to load. */
  onError?: (message: string) => void;
};

const maxSuggestions = 5;

/**
 * Lints prose words in a LaTeX file against a Hunspell dictionary. Spelling
 * diagnostics stay in the editor and are not reported to the Problems panel.
 */
export function spellcheck(options: SpellcheckOptions) {
  const { language, checker } = options;
  const label = spellingDictionaries[language].label;
  return [
    linter(
      async (view) => {
        const words = proseWords(view.state.doc.toString()).filter(
          ({ word }) => !options.isKnown(word),
        );
        let misspelled: Set<string>;
        try {
          misspelled = await checker.check(
            language,
            words.map(({ word }) => word),
          );
        } catch (cause) {
          options.onError?.(
            `Spell check is unavailable: ${cause instanceof Error ? cause.message : "the dictionary could not be loaded."}`,
          );
          return [];
        }
        return words
          .filter(({ word }) => misspelled.has(word))
          .map(({ from, to, word }) => diagnostic(from, to, word));
      },
      {
        delay: 500,
        needsRefresh: (update) =>
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) =>
              effect.is(personalDictionaryChanged),
            ),
          ),
      },
    ),
    EditorView.baseTheme({
      ".cm-lintRange.cm-spelling": {
        backgroundImage: "none",
        textDecoration: "underline wavy",
        textDecorationColor: "var(--destructive, #d33)",
        textDecorationThickness: "1px",
        textUnderlineOffset: "3px",
        textDecorationSkipInk: "none",
      },
      ".cm-spellingSuggestions": {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px",
        marginTop: "4px",
      },
    }),
  ];

  function diagnostic(from: number, to: number, word: string): Diagnostic {
    const result: Diagnostic = {
      from,
      to,
      severity: "info",
      markClass: "cm-spelling",
      source: "Spelling",
      message: `“${word}” is not in the ${label} dictionary.`,
      renderMessage: (view) => {
        const root = document.createElement("div");
        root.appendChild(document.createTextNode(result.message));
        if (view.state.readOnly) return root;
        const list = document.createElement("div");
        list.className = "cm-spellingSuggestions";
        list.setAttribute("aria-label", "Spelling suggestions");
        list.textContent = "Finding suggestions…";
        root.appendChild(list);
        void checker
          .suggest(language, word)
          .catch(() => [])
          .then((suggestions) => {
            list.textContent = suggestions.length ? "" : "No suggestions";
            for (const suggestion of suggestions.slice(0, maxSuggestions)) {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "cm-diagnosticAction";
              button.textContent = suggestion;
              // Keep editor focus so the tooltip stays open until the click.
              button.addEventListener("mousedown", (event) =>
                event.preventDefault(),
              );
              button.addEventListener("click", () =>
                replace(view, result, suggestion),
              );
              list.appendChild(button);
            }
          });
        return root;
      },
      actions: options.addWord
        ? [
            {
              name: "Add to dictionary",
              apply: () => options.addWord?.(word),
            },
          ]
        : [],
    };
    return result;
  }
}

/** Replaces a diagnostic's current range, which moves as the document changes. */
function replace(view: EditorView, target: Diagnostic, insert: string) {
  let range: { from: number; to: number } | undefined;
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    if (diagnostic === target) range = { from, to };
  });
  if (!range || view.state.readOnly) return;
  view.dispatch({
    changes: { ...range, insert },
    selection: { anchor: range.from + insert.length },
    userEvent: "input.complete",
  });
  view.focus();
}

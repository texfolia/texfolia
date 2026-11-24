import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { browserSpellChecker } from "#/lib/editor/spelling/checker";
import {
  personalDictionaryChanged,
  spellcheck,
} from "#/lib/editor/spelling/editor";
import type { SpellingLanguage } from "#/lib/editor/spelling/languages";
import { personalDictionaryHas } from "#/lib/settings/settings.schema";

/**
 * Configures LaTeX prose spellchecking and refreshes diagnostics whenever the
 * user's personal dictionary changes.
 */
export function useEditorSpellcheck({
  editor,
  filename,
  words,
  spellingLanguage,
  addWord,
}: {
  editor: RefObject<ReactCodeMirrorRef | null>;
  filename: string;
  words: readonly string[];
  spellingLanguage: SpellingLanguage | undefined;
  addWord: (word: string) => Promise<void> | void;
}) {
  const [spellingError, setSpellingError] = useState("");
  // Packages and classes are code, so only documents are spell checked.
  const checksSpelling =
    /\.(?:tex|ltx)$/i.test(filename) &&
    !!spellingLanguage &&
    spellingLanguage !== "off";

  const personalWords = useMemo(() => new Set(words), [words]);
  const personalWordsRef = useRef(personalWords);
  personalWordsRef.current = personalWords;
  const addWordRef = useRef(addWord);
  addWordRef.current = addWord;

  const spellingExtension = useMemo(
    () =>
      checksSpelling && spellingLanguage
        ? spellcheck({
            language: spellingLanguage,
            checker: browserSpellChecker(),
            isKnown: (word) =>
              personalDictionaryHas(personalWordsRef.current, word),
            // The personal dictionary belongs to the user, so viewers can add.
            addWord: (word) => void addWordRef.current(word),
            onError: setSpellingError,
          })
        : [],
    [checksSpelling, spellingLanguage],
  );

  useEffect(() => {
    setSpellingError("");
  }, [spellingExtension]);

  useEffect(() => {
    editor.current?.view?.dispatch({
      effects: personalDictionaryChanged.of(),
    });
  }, [editor, personalWords]);

  return { spellingExtension, spellingError };
}

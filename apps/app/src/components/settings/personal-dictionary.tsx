import { IconX } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@texfolia/ui/item";
import { useId, useState } from "react";

import {
  addPersonalWord,
  maxPersonalWords,
  personalWord,
} from "#/lib/settings/settings.schema";
import { useSettingsEditing } from "#/providers/settings-provider";

export function PersonalDictionary() {
  const { draft, setDraft } = useSettingsEditing();
  const id = useId();
  const [word, setWord] = useState("");
  const words = draft.spelling.words;
  const next = personalWord(word);
  const full = words.length >= maxPersonalWords;
  const setWords = (words: string[]) =>
    setDraft({ ...draft, spelling: { words } });
  return (
    <Item variant="outline">
      <ItemContent className="gap-5">
        <div>
          <ItemTitle>Personal dictionary</ItemTitle>
          <ItemDescription>
            Words here are never flagged in any project or language. They are
            stored in this browser. Lowercase words also match capitalized
            forms. Add to dictionary in the editor saves immediately.
          </ItemDescription>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!next || full) return;
            setWords(addPersonalWord(words, next));
            setWord("");
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor={`${id}-word`} className="sr-only">
              Word
            </FieldLabel>
            <Input
              id={`${id}-word`}
              value={word}
              placeholder="Add a word"
              maxLength={64}
              aria-invalid={!!word.trim() && !next}
              onChange={(event) => setWord(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={!next || full || words.includes(next)}
          >
            Add
          </Button>
        </form>
        {word.trim() && !next && (
          <p role="alert" className="text-destructive text-xs">
            Enter one word of up to 64 characters, without spaces or LaTeX.
          </p>
        )}
        {full && (
          <p className="text-muted-foreground text-xs">
            Your dictionary holds the maximum of {maxPersonalWords} words.
          </p>
        )}
        {words.length ? (
          <ul
            aria-label="Personal dictionary words"
            className="flex flex-wrap gap-2"
          >
            {words.map((entry) => (
              <li
                key={entry}
                className="bg-muted flex items-center gap-1 rounded-sm py-0.5 pr-0.5 pl-2 text-sm"
              >
                {entry}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${entry}`}
                  onClick={() =>
                    setWords(words.filter((existing) => existing !== entry))
                  }
                >
                  <IconX />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No words yet.</p>
        )}
      </ItemContent>
    </Item>
  );
}

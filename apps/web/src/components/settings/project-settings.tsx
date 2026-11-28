import { useLiveQuery } from "@tanstack/react-db";
import { useId, useSyncExternalStore } from "react";

import { LatexFormatSettingsFields } from "#/components/latex-format-settings";
import { Field, FieldLabel } from "#/components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "#/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import {
  spellingDictionaries,
  spellingLanguages,
  spellingLanguageSchema,
} from "#/lib/editor/spelling/languages";
import {
  isMainFileCandidate,
  projectMainFile,
  projectPaths,
} from "#/lib/projects";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useSettingsEditing } from "#/providers/settings-provider";

export function ProjectSettings() {
  return (
    <div className="min-h-64 py-1">
      <MainFileFields />
      <FormattingFields />
      <SpellingFields />
    </div>
  );
}

function MainFileFields() {
  const { project, draftMainFile, setDraftMainFile } = useSettingsEditing();
  const files = useProjectFiles();
  const saved = useSyncExternalStore(
    files.subscribe,
    () => files.getStatus().mainFile,
  );
  const { data: nodes } = useLiveQuery(files.nodes);
  const id = useId();
  const paths = projectPaths(nodes);
  const candidates = [...paths.values()].filter(isMainFileCandidate).sort();
  const chosen = draftMainFile === undefined ? saved : draftMainFile;
  const fallback = projectMainFile(paths, null)?.path;
  return (
    <Item variant="outline" className="mb-4 items-start">
      <ItemContent>
        <ItemTitle>Main document</ItemTitle>
        <ItemDescription>
          The file that is compiled. Shared by everyone in this project.
        </ItemDescription>
        <fieldset disabled={!project?.canWrite} className="mt-5">
          <Field>
            <FieldLabel htmlFor={`${id}-main`}>Main document</FieldLabel>
            <NativeSelect
              id={`${id}-main`}
              value={chosen ?? ""}
              onChange={(event) => {
                const next = event.target.value || null;
                setDraftMainFile(next === saved ? undefined : next);
              }}
            >
              <NativeSelectOption value="">
                {fallback ? `Automatic (${fallback})` : "Automatic"}
              </NativeSelectOption>
              {chosen !== null && !candidates.includes(chosen) && (
                <NativeSelectOption value={chosen} disabled>
                  {chosen} (missing)
                </NativeSelectOption>
              )}
              {candidates.map((path) => (
                <NativeSelectOption key={path} value={path}>
                  {path}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </fieldset>
      </ItemContent>
    </Item>
  );
}

function FormattingFields() {
  const settings = useSettingsEditing();
  return (
    <Item variant="outline" className="items-start">
      <ItemContent>
        <ItemTitle>LaTeX formatting</ItemTitle>
        <ItemDescription>
          Applied when you run Format document. These settings are shared by
          everyone in this project.
        </ItemDescription>
        {!settings.project?.canWrite && (
          <p className="text-muted-foreground text-sm">
            You have view access. A project editor can change these settings.
          </p>
        )}
        <fieldset disabled={!settings.project?.canWrite} className="mt-5">
          {settings.draftFormatting && (
            <LatexFormatSettingsFields
              settings={settings.draftFormatting}
              onChange={settings.setDraftFormatting}
            />
          )}
        </fieldset>
      </ItemContent>
    </Item>
  );
}

function SpellingFields() {
  const settings = useSettingsEditing();
  const id = useId();
  if (!settings.draftSpelling) return null;
  return (
    <Item variant="outline" className="mt-4 items-start">
      <ItemContent>
        <ItemTitle>Spelling</ItemTitle>
        <ItemDescription>
          Checks prose in LaTeX files, skipping commands, math, comments and
          label, reference and citation keys. Shared by everyone in this
          project.
        </ItemDescription>
        <fieldset disabled={!settings.project?.canWrite} className="mt-5">
          <Field>
            <FieldLabel htmlFor={`${id}-language`}>
              Spell-check language
            </FieldLabel>
            <NativeSelect
              id={`${id}-language`}
              value={settings.draftSpelling}
              onChange={(event) => {
                const language = spellingLanguageSchema.safeParse(
                  event.target.value,
                );
                if (language.success) settings.setDraftSpelling(language.data);
              }}
            >
              {spellingLanguages.map((language) => (
                <NativeSelectOption key={language} value={language}>
                  {language === "off"
                    ? "Off"
                    : spellingDictionaries[language].label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </fieldset>
      </ItemContent>
    </Item>
  );
}

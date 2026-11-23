import { Button } from "@texfolia/ui/button";
import { Checkbox } from "@texfolia/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useId, useState } from "react";

import {
  entryAppendix,
  parseReferenceId,
  setEntryKey,
  uniqueEntryKey,
  validEntryKey,
} from "#/features/editor/latex/bibtex";

export type AddReferenceRequest = {
  /** An undefined \cite key the new entry should define. */
  key?: string;
  /** A LaTeX file whose cursor can receive \cite{key}. */
  cite?: { path: string; insert: (key: string) => void };
};

type Lookup = { key: string; bibtex: string };

export const newBibFile = "references.bib";
const newTarget = "new";

/** Whether a .bib source mentions `doi`, compared without case. */
function mentionsDoi(source: string, doi: string) {
  return source.toLowerCase().includes(doi.toLowerCase());
}

export function AddReferenceDialog({
  request,
  onClose,
  bibFiles,
  knownKeys,
  readBib,
  appendBib,
  createBib,
}: {
  request: AddReferenceRequest | null;
  onClose: () => void;
  bibFiles: ReadonlyArray<{ id: string; path: string }>;
  knownKeys: readonly string[];
  readBib: (id: string) => string;
  /** Appends an entry; rejects when the file can't be edited yet. */
  appendBib: (id: string, entry: string) => Promise<void>;
  createBib: (content: string) => Promise<void>;
}) {
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {request && (
        <DialogContent className="sm:max-w-xl">
          <AddReferenceForm
            request={request}
            onClose={onClose}
            bibFiles={bibFiles}
            knownKeys={knownKeys}
            readBib={readBib}
            appendBib={appendBib}
            createBib={createBib}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function AddReferenceForm({
  request,
  onClose,
  bibFiles,
  knownKeys,
  readBib,
  appendBib,
  createBib,
}: Parameters<typeof AddReferenceDialog>[0] & {
  request: AddReferenceRequest;
}) {
  const id = useId();
  const [input, setInput] = useState("");
  const [target, setTarget] = useState(bibFiles[0]?.id ?? newTarget);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [key, setKey] = useState(request.key ?? "");
  const [cite, setCite] = useState(!!request.cite && !request.key);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const taken = new Set(knownKeys.map((value) => value.toLowerCase()));
  const duplicate = !!lookup && taken.has(key.toLowerCase());
  const invalidKey = !!lookup && !validEntryKey(key);
  const doi = lookup && /^\s*doi = \{([^}]+)\},?$/m.exec(lookup.bibtex)?.[1];
  const alreadyIn =
    doi && bibFiles.find((file) => mentionsDoi(readBib(file.id), doi))?.path;
  const targetPath =
    bibFiles.find((file) => file.id === target)?.path ?? newBibFile;

  async function find() {
    const parsed = parseReferenceId(input);
    if (!parsed) {
      setError("Enter a DOI, arXiv ID or ISBN.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/references?id=${encodeURIComponent(input.trim())}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const body = (await response.json().catch(() => null)) as
        | (Lookup & { error?: undefined })
        | { error?: string }
        | null;
      if (!response.ok || !body || !("bibtex" in body)) {
        setError(
          body?.error ??
            "The reference could not be looked up. Check your connection and try again.",
        );
        return;
      }
      setLookup(body);
      setKey(request.key ?? uniqueEntryKey(body.key, knownKeys));
    } catch {
      setError(
        "The reference could not be looked up. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  async function add(entry: string) {
    setPending(true);
    setError("");
    try {
      if (target === newTarget) await createBib(entryAppendix("", entry));
      else await appendBib(target, entry);
      if (cite) request.cite?.insert(key);
      onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? `Could not add the reference. ${error.message}`
          : "Could not add the reference. Try again.",
      );
      setPending(false);
    }
  }

  const entry = lookup ? setEntryKey(lookup.bibtex, key) : "";
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        if (!lookup) void find();
        else if (!duplicate && !invalidKey) void add(entry);
      }}
    >
      <DialogHeader>
        <DialogTitle>Add reference</DialogTitle>
        <DialogDescription>
          {request.key
            ? `Look up the work cited as “${request.key}” and add it to a bibliography file.`
            : "Look up a work by its identifier and add it to a bibliography file."}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${id}-input`}>DOI, arXiv ID or ISBN</FieldLabel>
        <Input
          id={`${id}-input`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setLookup(null);
            setError("");
          }}
          placeholder="10.1145/3368089.3409741, 1706.03762 or 978-0-201-52983-8"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-target`}>Add to</FieldLabel>
        <NativeSelect
          id={`${id}-target`}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={pending}
          className="w-full"
        >
          {bibFiles.map((file) => (
            <NativeSelectOption key={file.id} value={file.id}>
              {file.path}
            </NativeSelectOption>
          ))}
          {!bibFiles.length && (
            <NativeSelectOption value={newTarget}>
              New file: {newBibFile}
            </NativeSelectOption>
          )}
        </NativeSelect>
        {target === newTarget && (
          <FieldDescription>
            Load it in your preamble with{" "}
            <code>{`\\addbibresource{${newBibFile}}`}</code> (biblatex) or{" "}
            <code>{"\\bibliography{references}"}</code>.
          </FieldDescription>
        )}
      </Field>
      {lookup && (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-key`}>Citation key</FieldLabel>
            <Input
              id={`${id}-key`}
              value={key}
              onChange={(event) => setKey(event.target.value.trim())}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={duplicate || invalidKey}
              aria-describedby={`${id}-key-note`}
            />
            {duplicate ? (
              <FieldError id={`${id}-key-note`}>
                “{key}” is already defined in this project.{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => setKey(uniqueEntryKey(key, knownKeys))}
                >
                  Use “{uniqueEntryKey(key, knownKeys)}”
                </Button>
              </FieldError>
            ) : invalidKey ? (
              <FieldError id={`${id}-key-note`}>
                Keys can't be empty or contain spaces, commas, braces or quotes.
              </FieldError>
            ) : (
              <FieldDescription id={`${id}-key-note`}>
                Cite it with <code>{`\\cite{${key}}`}</code>.
              </FieldDescription>
            )}
          </Field>
          {alreadyIn && (
            <p role="status" className="text-muted-foreground text-xs">
              This DOI is already in {alreadyIn}.
            </p>
          )}
          <pre
            aria-label="BibTeX entry"
            className="bg-muted max-h-56 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
          >
            {entry}
          </pre>
          {request.cite && !request.key && (
            <Field orientation="horizontal">
              <Checkbox
                id={`${id}-cite`}
                checked={cite}
                onCheckedChange={setCite}
                disabled={pending}
              />
              <FieldLabel htmlFor={`${id}-cite`}>
                Cite it at the cursor in {request.cite.path}
              </FieldLabel>
            </Field>
          )}
        </>
      )}
      {error && (
        <FieldError role="alert" className="wrap-anywhere">
          {error}
        </FieldError>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={pending || !input.trim() || duplicate || invalidKey}
        >
          {pending
            ? lookup
              ? "Adding…"
              : "Looking up…"
            : lookup
              ? `Add to ${targetPath}`
              : "Look up"}
        </Button>
      </DialogFooter>
    </form>
  );
}

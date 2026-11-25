import { z } from "zod";

/** How much text around an edit its result keeps, to find the edit again. */
const contextLength = 80;

const editSchema = z.object({ oldText: z.string(), newText: z.string() });
/** The text just around an edit's new text, as it was saved. */
const contextSchema = z.object({ before: z.string(), after: z.string() });
export type AppliedEdit = z.infer<typeof editSchema> &
  z.infer<typeof contextSchema>;

/** A file change the assistant made, read from its tool call and result. */
export type AssistantChange =
  | { kind: "edit"; path: string; nodeId: string; edits: AppliedEdit[] }
  | { kind: "create"; path: string; nodeId: string; content: string }
  | { kind: "rename"; path: string; newPath: string; nodeId: string }
  | { kind: "delete"; path: string }
  | { kind: "git"; action: "pull" | "checkout" };

/** The context of replacements, given the text after them all. */
export function editContext(
  text: string,
  ranges: readonly { from: number; to: number }[],
) {
  return ranges.map(({ from, to }) => ({
    before: text.slice(Math.max(0, from - contextLength), from),
    after: text.slice(to, to + contextLength),
  }));
}

const callSchemas = {
  edit_file: z.object({ path: z.string(), edits: z.array(editSchema) }),
  create_file: z.object({ path: z.string(), content: z.string().default("") }),
  rename_file: z.object({ path: z.string(), newPath: z.string() }),
  delete_file: z.object({ path: z.string() }),
};
const resultSchemas = {
  // Edits of chats from before this feature have no context.
  edit_file: z.object({
    nodeId: z.string(),
    context: z.array(contextSchema),
  }),
  node: z.object({ nodeId: z.string() }),
};

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The change a finished tool call made, or null for a call that changed no
 * files, failed, or recorded too little to undo.
 */
export function assistantChange(
  call: { name: string; arguments: string },
  result: { content: unknown; state: string } | undefined,
): AssistantChange | null {
  if (result?.state !== "complete") return null;
  const input = json(call.arguments);
  const output =
    typeof result.content === "string" ? json(result.content) : result.content;
  // A tool's error is a result too.
  if (z.object({ error: z.string() }).safeParse(output).success) return null;
  switch (call.name) {
    case "edit_file": {
      const edit = callSchemas.edit_file.safeParse(input);
      const saved = resultSchemas.edit_file.safeParse(output);
      if (!edit.success || !saved.success) return null;
      const { nodeId, context } = saved.data;
      if (context.length !== edit.data.edits.length) return null;
      return {
        kind: "edit",
        path: edit.data.path,
        nodeId,
        edits: edit.data.edits.map((change, index) => ({
          ...change,
          before: context[index]?.before ?? "",
          after: context[index]?.after ?? "",
        })),
      };
    }
    case "create_file": {
      const created = callSchemas.create_file.safeParse(input);
      const saved = resultSchemas.node.safeParse(output);
      return created.success && saved.success
        ? { kind: "create", ...created.data, nodeId: saved.data.nodeId }
        : null;
    }
    case "rename_file": {
      const renamed = callSchemas.rename_file.safeParse(input);
      const saved = resultSchemas.node.safeParse(output);
      return renamed.success && saved.success
        ? { kind: "rename", ...renamed.data, nodeId: saved.data.nodeId }
        : null;
    }
    case "delete_file": {
      const deleted = callSchemas.delete_file.safeParse(input);
      return deleted.success
        ? { kind: "delete", path: deleted.data.path }
        : null;
    }
    case "git_pull":
      return { kind: "git", action: "pull" };
    case "git_checkout":
      return { kind: "git", action: "checkout" };
    default:
      return null;
  }
}

function occurrences(text: string, part: string) {
  const found: number[] = [];
  // Only an empty file has exactly one place for nothing.
  if (!part) return text ? found : [0];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1))
    found.push(at);
  return found;
}

function commonEnd(a: string, b: string) {
  let length = 0;
  while (
    length < Math.min(a.length, b.length) &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  )
    length++;
  return length;
}

function commonStart(a: string, b: string) {
  let length = 0;
  while (length < Math.min(a.length, b.length) && a[length] === b[length])
    length++;
  return length;
}

/** Where `part` is, between its context: exactly one place, or nowhere. */
function place(text: string, part: string, { before, after }: AppliedEdit) {
  // At the start or end of the file, only that place has its context.
  const found = occurrences(text, before + part + after).filter(
    (at) =>
      (before.length >= contextLength || at === 0) &&
      (after.length >= contextLength ||
        at + before.length + part.length + after.length === text.length),
  );
  return found.length === 1 ? found[0]! + before.length : undefined;
}

/**
 * Where an edit's new text still is although the text around it has changed:
 * the one place that has enough in common with it.
 */
function nearestPlace(text: string, edit: AppliedEdit) {
  const { newText, before, after } = edit;
  const scored = (
    newText
      ? occurrences(text, newText)
      : // Deleted text leaves a seam, which both of its sides must still touch.
        occurrences(text, before.slice(-12) + after.slice(0, 12)).map(
          (at) => at + Math.min(12, before.length),
        )
  ).map((at) => ({
    at,
    common:
      commonEnd(text.slice(Math.max(0, at - contextLength), at), before) +
      commonStart(
        text.slice(at + newText.length, at + newText.length + contextLength),
        after,
      ),
  }));
  const best = scored.sort((a, b) => b.common - a.common)[0];
  if (!best) return undefined;
  const next = scored[1]?.common ?? -1;
  // Short new text, such as a word, is only certain with its surroundings.
  const needed = newText ? Math.max(0, 24 - newText.length) : 20;
  const available = before.length + after.length;
  return best.common >= Math.min(needed, available) && best.common > next
    ? best.at
    : undefined;
}

export type RevertedEdit = "reverted" | "already" | "conflict";

/**
 * Undoes edits in the current text of their file. An edit whose passage has
 * been changed since is left alone.
 */
export function revertEdits(text: string, edits: readonly AppliedEdit[]) {
  const changes: { from: number; to: number; insert: string }[] = [];
  const outcomes = edits.map((edit): RevertedEdit => {
    const { oldText, newText } = edit;
    if (oldText === newText) return "already";
    const exact = place(text, newText, edit);
    if (exact === undefined && place(text, oldText, edit) !== undefined)
      return "already";
    const from = exact ?? nearestPlace(text, edit);
    if (from === undefined) return "conflict";
    const to = from + newText.length;
    if (changes.some((change) => from < change.to && change.from < to))
      return "conflict";
    changes.push({ from, to, insert: oldText });
    return "reverted";
  });
  return { changes, outcomes };
}

/** The text after changes that do not overlap. */
export function applyChanges(
  text: string,
  changes: readonly { from: number; to: number; insert: string }[],
) {
  let result = text;
  for (const { from, to, insert } of [...changes].sort(
    (a, b) => b.from - a.from,
  ))
    result = result.slice(0, from) + insert + result.slice(to);
  return result;
}

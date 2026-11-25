import type { Store } from "#/lib/external-store";

import type { AssistantChange } from "./revert";

/** What became of undoing one change. */
export type RevertOutcome = {
  change: AssistantChange;
  outcome: "reverted" | "already" | "partial" | "skipped";
  /** Why some or all of it was not undone. */
  reason?: string;
};

/** What the assistant's panel can do in the workspace around it. */
export type AssistantEditor = {
  canWrite: boolean;
  /** The project's file paths, to mention. */
  files: readonly string[];
  reveal: (path: string) => void;
  /** Undoes changes in the given order, so pass the latest first. */
  revert: (changes: readonly AssistantChange[]) => Promise<RevertOutcome[]>;
  /** Text to add to the message being written, until a chat takes it. */
  prompt: Store<string | null>;
};

/** Names a file in a message. */
export function fileMention(path: string) {
  return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The start of a mention before the cursor, which is being completed. */
export function mentionBefore(text: string) {
  const match = /(?:^|[\s(])@("[^"\n]*|[^\s"@]*)$/.exec(text);
  if (!match) return null;
  const query = match[1] ?? "";
  return {
    /** Where its @ is. */
    from: text.length - query.length - 1,
    query: query.replace(/^"/, ""),
  };
}

const maxSelection = 8 * 1024;

/** A message about part of a file, which its question follows. */
export function selectionPrompt(
  path: string,
  { text, from, to }: { text: string; from: number; to: number },
) {
  const lines = from === to ? `line ${from}` : `lines ${from}–${to}`;
  const shown =
    text.length > maxSelection ? `${text.slice(0, maxSelection)}…` : text;
  // A longer fence than any in the text.
  const fence = "`".repeat(
    Math.max(3, ...(shown.match(/`+/g) ?? []).map((run) => run.length + 1)),
  );
  return `About ${fileMention(path)}, ${lines}:\n\n${fence}\n${shown}\n${fence}\n\n`;
}

export function problemPrompt(problem: {
  path: string;
  line: number;
  message: string;
}) {
  return `Fix this problem in ${fileMention(problem.path)}, line ${problem.line}: ${problem.message}`;
}

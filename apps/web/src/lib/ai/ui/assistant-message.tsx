import { IconArrowBackUp, IconCopy, IconRefresh } from "@tabler/icons-react";
import type { ToolCallPart, ToolResultPart } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-react";
import { Markdown } from "@tanstack/markdown/react";
import type { ComponentProps } from "react";

import { Button } from "#/components/ui/button";
import { CodeBlock, CodeBlockContent } from "#/components/ui/code-block";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "#/components/ui/message";

import type { AssistantEditor, RevertOutcome } from "../editor";
import { type AssistantChange, assistantChange } from "../revert";
import { ChangeCard, describeChange, isFileChange } from "./change-card";
import { Reasoning } from "./reasoning";
import { Sources } from "./sources";
import { Tool } from "./tool";

type Part = { type: string };
const isToolCall = (part: Part): part is ToolCallPart =>
  part.type === "tool-call";
const isToolResult = (part: Part): part is ToolResultPart =>
  part.type === "tool-result";

function toolResult(parts: readonly Part[], call: ToolCallPart) {
  return parts
    .filter(isToolResult)
    .find((result) => result.toolCallId === call.id);
}

// A finished message keeps its parts while later ones stream.
const changeCache = new WeakMap<
  readonly Part[],
  ReadonlyMap<string, AssistantChange>
>();

/** The changes a message made to the project's files, by tool call. */
export function messageChanges(parts: readonly Part[]) {
  let changes = changeCache.get(parts);
  if (!changes) {
    changes = new Map(
      parts.filter(isToolCall).flatMap((call) => {
        const change = assistantChange(call, toolResult(parts, call));
        return change ? [[call.id, change] as const] : [];
      }),
    );
    changeCache.set(parts, changes);
  }
  return changes;
}

const markdownComponents = {
  pre: ({ children }: ComponentProps<"pre">) => (
    <CodeBlock size="sm" className="my-3">
      <CodeBlockContent wrap>{children}</CodeBlockContent>
    </CodeBlock>
  ),
};

/** One message of a chat, with what can be done about it. */
export function AssistantMessage({
  message,
  last,
  running,
  disabled,
  editor,
  rollback,
  onUndo,
  onRetry,
  onError,
}: {
  message: UIMessage;
  /** It ends the conversation. */
  last: boolean;
  /** A reply is being written. */
  running: boolean;
  /** Changes cannot be undone now. */
  disabled: boolean;
  editor: AssistantEditor;
  /** Set once its changes are being undone, with outcomes when they were. */
  rollback: { outcomes?: RevertOutcome[] } | undefined;
  /** Omitted when there are no changes to undo. */
  onUndo: (() => void) | undefined;
  /** Omitted when no reply can be written now. */
  onRetry: (() => void) | undefined;
  onError: (message: string) => void;
}) {
  return (
    <Message align={message.role === "user" ? "end" : "start"}>
      <MessageContent>
        <MessageHeader>
          {message.role === "user" ? "You" : "Assistant"}
        </MessageHeader>
        {message.parts.map((part, index) => {
          if (part.type === "text")
            return (
              <div
                key={index}
                className="leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-3 [&_ul]:list-disc"
              >
                <Markdown components={markdownComponents}>
                  {part.content}
                </Markdown>
              </div>
            );
          if (
            part.type === "thinking" &&
            !("redacted" in part && part.redacted)
          )
            return (
              <Reasoning
                key={index}
                text={part.content}
                running={running && last}
              />
            );
          if (part.type === "tool-call") {
            const change = messageChanges(message.parts).get(part.id);
            if (change && isFileChange(change))
              return (
                <ChangeCard
                  key={part.id}
                  change={change}
                  editor={editor}
                  disabled={disabled}
                  defaultOpen={last}
                />
              );
            return (
              <Tool
                key={part.id}
                part={part}
                result={toolResult(message.parts, part)}
                running={running}
              />
            );
          }
          return null;
        })}
        {message.role === "assistant" && (
          <Sources
            urls={message.parts
              .filter((part) => part.type === "text")
              .flatMap(
                (part) => part.content.match(/https?:\/\/[^\s<>\])]+/g) ?? [],
              )}
          />
        )}
        <MessageFooter className="gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy message"
            onClick={() => {
              void navigator.clipboard
                .writeText(
                  message.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.content)
                    .join("\n"),
                )
                .catch(() =>
                  onError(
                    "Clipboard access failed. Select the message text to copy it.",
                  ),
                );
            }}
          >
            <IconCopy />
          </Button>
          {onUndo && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Undo changes from here"
              title="Undo the file changes made from this message on"
              disabled={disabled}
              onClick={onUndo}
            >
              <IconArrowBackUp />
            </Button>
          )}
          {message.role === "assistant" && last && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Retry message"
              disabled={!onRetry}
              onClick={onRetry}
            >
              <IconRefresh />
            </Button>
          )}
        </MessageFooter>
        {rollback && <Rollback outcomes={rollback.outcomes} />}
      </MessageContent>
    </Message>
  );
}

function Rollback({ outcomes }: { outcomes: RevertOutcome[] | undefined }) {
  if (!outcomes)
    return (
      <p role="status" className="text-muted-foreground text-xs">
        Undoing changes…
      </p>
    );
  const undone = outcomes.filter(({ outcome }) =>
    ["reverted", "partial"].includes(outcome),
  ).length;
  const skipped = outcomes.filter(({ outcome }) =>
    ["skipped", "partial"].includes(outcome),
  );
  return (
    <div role="status" className="text-muted-foreground space-y-1 text-xs">
      <p>
        {undone
          ? `Undid ${undone} ${undone === 1 ? "change" : "changes"}.`
          : skipped.length
            ? "No changes were undone."
            : "These changes were already undone."}
      </p>
      {skipped.length > 0 && (
        <ul aria-label="Changes that were kept" className="list-disc pl-4">
          {skipped.map(({ change, outcome, reason }, index) => (
            <li key={index}>
              {describeChange(change)}
              {outcome === "partial" ? ", in part" : ""}: {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

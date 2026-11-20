import type { ModelMessage } from "@tanstack/ai";

/**
 * Estimated input tokens for the conversation history of one model request.
 * The system prompt and tool schemas are sent on top of this.
 */
export const historyTokenBudget = 24_000;
/** Strings longer than this in earlier turns' tool traffic are elided. */
const staleStringLimit = 400;
/** Upper bound for the digest of dropped turns. */
const digestTokenLimit = 1_500;
/** Dropped turns are cut in steps of this many turns. */
const cutStride = 8;

const encoder = new TextEncoder();
const sizes = new WeakMap<ModelMessage, number>();
/** UTF-8 bytes of one message plus framing. Messages are never mutated. */
function messageBytes(message: ModelMessage) {
  let bytes = sizes.get(message);
  if (bytes === undefined) {
    bytes = encoder.encode(JSON.stringify(message)).byteLength + 16;
    sizes.set(message, bytes);
  }
  return bytes;
}
/** A conservative estimate: about four UTF-8 bytes per token. */
export function estimateTokens(messages: readonly ModelMessage[]) {
  let bytes = 0;
  for (const message of messages) bytes += messageBytes(message);
  return Math.ceil(bytes / 4);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function elide(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [${text.length - limit} more characters omitted from history]`;
}

/** Replaces long strings anywhere in a JSON value, so the value stays valid JSON. */
function elideStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") return elide(value, limit);
  if (Array.isArray(value))
    return value.map((item) => elideStrings(item, limit));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        elideStrings(item, limit),
      ]),
    );
  return value;
}

function textOf(content: ModelMessage["content"]) {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("");
}

/** Shrinks a tool result to what the model needs once its turn is over. */
export function stubToolResult(
  toolName: string | undefined,
  content: string,
  limit = staleStringLimit,
) {
  const parsed = parseJson(content);
  if (parsed === undefined) return elide(content, limit);
  if (
    toolName === "read_file" &&
    parsed &&
    typeof parsed === "object" &&
    "content" in parsed
  ) {
    const { path, version } = parsed as { path?: unknown; version?: unknown };
    return JSON.stringify({
      path,
      version,
      content: `[File read at version ${String(version)}. Its text is omitted from history; call read_file again for the current text.]`,
    });
  }
  const stubbed = JSON.stringify(elideStrings(parsed, limit));
  return stubbed.length < content.length ? stubbed : content;
}

function stubToolArguments(args: string, limit = staleStringLimit) {
  const parsed = parseJson(args);
  if (parsed === undefined) return args.length > limit ? "{}" : args;
  const stubbed = JSON.stringify(elideStrings(parsed, limit));
  return stubbed.length < args.length ? stubbed : args;
}

function toolNames(messages: readonly ModelMessage[]) {
  const names = new Map<string, string>();
  for (const message of messages)
    for (const call of message.toolCalls ?? [])
      names.set(call.id, call.function.name);
  return names;
}

/** Stubs the tool traffic and drops the thinking of one finished turn. */
function compactStale(
  message: ModelMessage,
  names: ReadonlyMap<string, string>,
): ModelMessage {
  if (message.role === "tool" && typeof message.content === "string")
    return {
      ...message,
      content: stubToolResult(
        message.toolCallId ? names.get(message.toolCallId) : undefined,
        message.content,
      ),
    };
  if (message.role === "assistant") {
    const { thinking: _thinking, blockOrder: _blockOrder, ...rest } = message;
    return {
      ...rest,
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              function: {
                ...call.function,
                arguments: stubToolArguments(call.function.arguments),
              },
            })),
          }
        : {}),
    };
  }
  return message;
}

/** One line per dropped message: what the user asked and what was done. */
function digest(dropped: readonly ModelMessage[]) {
  const lines: string[] = [];
  for (const message of dropped) {
    if (message.role === "user")
      lines.push(`- User: ${elide(textOf(message.content).trim(), 300)}`);
    if (message.role === "assistant") {
      const text = textOf(message.content).trim();
      if (text) lines.push(`- Assistant: ${elide(text, 300)}`);
      for (const call of message.toolCalls ?? []) {
        const args = parseJson(call.function.arguments);
        const path =
          args && typeof args === "object" && "path" in args
            ? ` ${String(args.path)}`
            : "";
        lines.push(`  - Tool: ${call.function.name}${path}`);
      }
    }
  }
  let text = lines.join("\n");
  const limit = digestTokenLimit * 4;
  if (text.length > limit) text = `…\n${text.slice(text.length - limit)}`;
  return `[Summary of ${dropped.length} earlier messages, omitted to keep the request small. Their file contents may be out of date: read files again before editing them.]\n${text}`;
}

function startsOfTurns(messages: readonly ModelMessage[]) {
  const starts: number[] = [];
  for (const [index, message] of messages.entries())
    if (message.role === "user") starts.push(index);
  return starts;
}

/**
 * Builds the provider context for one model call from the full transcript.
 *
 * - Turns before the latest user message keep their text, but their tool
 *   results and tool arguments are stubbed and their thinking is dropped.
 *   This is deterministic per turn, so the prefix stays stable for provider
 *   prefix caching until the budget forces older turns out.
 * - When the history is still over budget, whole turns are dropped oldest
 *   first and replaced by a short digest in the first kept user message.
 * - When the current turn alone is over budget, its older tool results are
 *   stubbed too, and the newest one is truncated last.
 */
export function compactHistory(
  messages: readonly ModelMessage[],
  budget = historyTokenBudget,
): ModelMessage[] {
  const starts = startsOfTurns(messages);
  const current = starts.at(-1) ?? 0;
  const names = toolNames(messages);
  const stale = messages
    .slice(0, current)
    .map((message) => compactStale(message, names));
  const tail = messages.slice(current);
  let result = [...stale, ...tail];
  if (estimateTokens(result) <= budget) return result;

  // Drop whole earlier turns, oldest first, until the rest fits.
  const available = (budget - digestTokenLimit) * 4 - estimateTokens(tail) * 4;
  // Prefer cuts on every cutStride-th turn, so the cut (and the cached
  // prefix after it) moves only every few turns instead of on every turn.
  const ordinals = new Map(starts.map((start, ordinal) => [start, ordinal]));
  let cut = current;
  let aligned: number | undefined;
  let keptBytes = 0;
  for (let index = current - 1; index > 0; index--) {
    const bytes = keptBytes + messageBytes(stale[index]!);
    if (bytes > available) break;
    keptBytes = bytes;
    const ordinal = ordinals.get(index);
    if (ordinal === undefined) continue;
    cut = index;
    if (ordinal % cutStride === 0) aligned = index;
  }
  cut = aligned ?? cut;
  if (cut > 0) {
    const [first, ...rest] = [...stale.slice(cut), ...tail];
    if (first)
      result = [
        {
          ...first,
          content: `${digest(stale.slice(0, cut))}\n\n${textOf(first.content)}`,
        },
        ...rest,
      ];
    if (estimateTokens(result) <= budget) return result;
  }

  // The current turn alone is too large: stub its older tool results first,
  // and truncate the newest one only if that is still not enough.
  const offset = result.length - tail.length;
  const toolIndexes = result.flatMap((message, index) =>
    index >= offset && message.role === "tool" ? [index] : [],
  );
  for (const index of toolIndexes) {
    const message = result[index];
    if (!message || typeof message.content !== "string") continue;
    const over = estimateTokens(result) - budget;
    if (over <= 0) break;
    result[index] = {
      ...message,
      content:
        index === toolIndexes.at(-1)
          ? elide(
              message.content,
              Math.max(staleStringLimit, message.content.length - over * 4),
            )
          : stubToolResult(
              message.toolCallId ? names.get(message.toolCallId) : undefined,
              message.content,
            ),
    };
  }
  return result;
}

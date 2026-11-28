export type MentionCandidate = {
  id: string;
  name: string;
  image: string | null;
};

export type ResolvedMention = {
  id: string;
  name: string;
  image: string | null;
  status: "active" | "former" | "deleted";
};

export type MentionSegment =
  | { kind: "text"; text: string }
  | {
      kind: "mention";
      userId: string;
      fallbackName: string;
      raw: string;
      from: number;
      to: number;
    };

// Structured mention token: `@[Display Name](mention:<userId>)`.
// Uses valid Markdown link syntax with a `mention:` scheme so it works
// uniformly in review comments, the collaborative Markdown scratchpad, and
// Markdown previews without colliding with AI chat `@file` mentions.
const mentionTokenPattern =
  /@\[([^\]\r\n]+)\]\(mention:([A-Za-z0-9_-]{1,128})\)/g;

/** Formats a person into a structured mention token. */
export function formatMentionToken(person: { id: string; name: string }) {
  const safeName =
    person.name
      .replaceAll(/[[\]\r\n]+/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim() || "User";
  return `@[${safeName}](mention:${person.id})`;
}

/** Splits text into plain text and structured mention segments. */
export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(mentionTokenPattern)) {
    const from = match.index ?? 0;
    const raw = match[0];
    const fallbackName = match[1] ?? "";
    const userId = match[2] ?? "";
    if (from > cursor)
      segments.push({ kind: "text", text: text.slice(cursor, from) });
    segments.push({
      kind: "mention",
      userId,
      fallbackName,
      raw,
      from,
      to: from + raw.length,
    });
    cursor = from + raw.length;
  }
  if (cursor < text.length)
    segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** Returns unique mentioned user IDs in order of first appearance. */
export function extractMentionedUserIds(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const segment of parseMentions(text)) {
    if (segment.kind !== "mention" || seen.has(segment.userId)) continue;
    seen.add(segment.userId);
    ids.push(segment.userId);
  }
  return ids;
}

/**
 * Replaces mention tokens whose user ID is not in `allowedUserIds` with plain
 * `@Name` text so unauthorized or fabricated IDs are never stored or leaked.
 */
export function sanitizeUnauthorizedMentions(
  text: string,
  allowedUserIds: ReadonlySet<string>,
) {
  return text.replaceAll(
    mentionTokenPattern,
    (raw, fallbackName: string, userId: string) =>
      allowedUserIds.has(userId) ? raw : `@${fallbackName}`,
  );
}

/**
 * Detects an active `@query` right before the cursor (end of `text`).
 * Ignores email addresses (e.g. `user@example.com`) and completed mention tokens.
 */
export function mentionQueryBefore(
  text: string,
): { from: number; query: string } | null {
  const match = /(?:^|[\s([{"'])@([^\r\n@[\]()]{0,50})$/.exec(text);
  if (!match) return null;
  const query = match[1] ?? "";
  // Avoid keeping the picker open over long multi-word prose after a stray `@`.
  if ((query.match(/\s/g)?.length ?? 0) > 2) return null;
  return {
    from: text.length - query.length - 1,
    query,
  };
}

/** Renders structured mention tokens as readable `@Name` plain text. */
export function renderPlainTextMentions(
  text: string,
  resolveName?: (userId: string, fallbackName: string) => string,
) {
  return text.replaceAll(
    mentionTokenPattern,
    (_raw, fallbackName: string, userId: string) =>
      `@${resolveName ? resolveName(userId, fallbackName) : fallbackName}`,
  );
}

/** Builds a compact single-line excerpt for notifications and emails. */
export function mentionExcerpt(
  text: string,
  resolveName?: (userId: string, fallbackName: string) => string,
  maxLength = 200,
) {
  const plain = renderPlainTextMentions(text, resolveName)
    .replaceAll(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, maxLength - 1).trimEnd()}…`;
}

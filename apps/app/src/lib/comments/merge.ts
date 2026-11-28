/**
 * Merges a single fetched comment thread into the cached project comment list,
 * keeping threads ordered by `createdAt` and removing the thread when `null`.
 */
export function mergeCommentThread<
  TThread extends { id: string; createdAt: Date | string },
  TData extends {
    userId: string;
    canComment: boolean;
    canModerate: boolean;
    threads: TThread[];
    mentions?: Record<string, unknown>;
  },
>(
  current: TData | undefined,
  update: {
    userId: string;
    canComment: boolean;
    canModerate: boolean;
    threadId: string;
    thread: TThread | null;
    mentions?: TData["mentions"];
  },
): TData | undefined {
  if (!current) return current;
  const remaining = current.threads.filter(
    (item) => item.id !== update.threadId,
  );
  const threads = update.thread
    ? [...remaining, update.thread].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
    : remaining;
  return {
    ...current,
    userId: update.userId,
    canComment: update.canComment,
    canModerate: update.canModerate,
    threads,
    ...(current.mentions !== undefined || update.mentions !== undefined
      ? { mentions: { ...current.mentions, ...update.mentions } }
      : {}),
  };
}

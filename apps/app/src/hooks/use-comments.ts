import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { CommentAnchor } from "#/lib/comments/anchor";
import { mergeCommentThread } from "#/lib/comments/merge";
import {
  getCommentThread,
  listComments,
} from "#/lib/comments/project-comments.functions";
import {
  useProjectBuildEvents,
  useProjectFiles,
} from "#/providers/project-files-provider";

export type CommentThreads = Awaited<ReturnType<typeof listComments>>;
export type CommentThread = CommentThreads["threads"][number];
export type CommentDraft = CommentAnchor & { nodeId: string; quote: string };

export type Comments = {
  data: CommentThreads | undefined;
  error: string;
  draft: CommentDraft | null;
  activeId: string | undefined;
  // Bumped whenever a thread is selected from the editor, so the Comments
  // view scrolls to it even when it was already active.
  focusSequence: number;
  startComment: (draft: CommentDraft) => void;
  cancelDraft: () => void;
  selectThread: (id: string | undefined, focus?: boolean) => void;
  // Runs a mutation, then refreshes only the affected thread when known.
  run: <T>(action: () => Promise<T>, threadId?: string) => Promise<T>;
};

// Review comments for the project workspace. Single-thread updates arrive via
// WebSocket push and fetch only the changed thread; full reloads happen on open
// and whenever metadata resyncs report a new comments version (e.g. reconnect
// or role change).
export function useComments({
  projectId,
  onShow,
}: {
  projectId: string;
  // Opens the Comments view.
  onShow: () => void;
}): Comments {
  const files = useProjectFiles();
  const buildEvents = useProjectBuildEvents();
  const version = useSyncExternalStore(
    files.subscribe,
    () => files.getStatus().commentsVersion,
    () => undefined,
  );
  const [data, setData] = useState<CommentThreads>();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const [focusSequence, setFocusSequence] = useState(0);
  const request = useRef(0);
  const threadRequests = useRef(new Map<string, number>());
  const show = useRef(onShow);
  show.current = onShow;

  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const next = await listComments({ data: { projectId } });
      // A slower, older response must not replace a newer one.
      if (sequence !== request.current) return;
      setData(next);
      setError("");
    } catch {
      if (sequence === request.current)
        setError("Could not load comments. They will retry when connected.");
    }
  }, [projectId]);

  const refreshThread = useCallback(
    async (threadId: string) => {
      const fullAtStart = request.current;
      const sequence = (threadRequests.current.get(threadId) ?? 0) + 1;
      threadRequests.current.set(threadId, sequence);
      try {
        const next = await getCommentThread({ data: { projectId, threadId } });
        if (
          fullAtStart !== request.current ||
          threadRequests.current.get(threadId) !== sequence
        )
          return;
        setData((current) =>
          mergeCommentThread(current, { ...next, threadId }),
        );
        setError("");
      } catch {
        // Keep existing threads; a reconnect resync will reconcile.
      }
    },
    [projectId],
  );

  // Full load on open and on metadata resyncs (reconnect, role change, file deletion).
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // Incremental single-thread updates pushed over the live WebSocket.
  useEffect(() => {
    if (!buildEvents) return;
    const unsubscribe = buildEvents.subscribe((event) => {
      if (event.kind === "comment") void refreshThread(event.threadId);
    });
    return () => {
      unsubscribe();
    };
  }, [buildEvents, refreshThread]);

  const run = useCallback(
    async <T>(action: () => Promise<T>, threadId?: string) => {
      let result: T | undefined;
      let targetThreadId = threadId;
      try {
        result = await action();
        if (
          !targetThreadId &&
          result &&
          typeof result === "object" &&
          "threadId" in result &&
          typeof result.threadId === "string"
        )
          targetThreadId = result.threadId;
        return result;
      } finally {
        if (targetThreadId) await refreshThread(targetThreadId);
        else await refresh();
      }
    },
    [refresh, refreshThread],
  );

  return useMemo<Comments>(
    () => ({
      data,
      error,
      draft,
      activeId,
      focusSequence,
      startComment: (next) => {
        setDraft(next);
        setActiveId(undefined);
        show.current();
      },
      cancelDraft: () => setDraft(null),
      selectThread: (id, focus = false) => {
        setActiveId(id);
        if (focus && id) {
          setFocusSequence((sequence) => sequence + 1);
          show.current();
        }
      },
      run,
    }),
    [data, error, draft, activeId, focusSequence, run],
  );
}

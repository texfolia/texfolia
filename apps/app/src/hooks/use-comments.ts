import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { CommentAnchor } from "#/features/comments/anchor";
import { listComments } from "#/features/comments/project-comments.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

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
  // Runs a mutation, then reloads the threads.
  run: <T>(action: () => Promise<T>) => Promise<T>;
};

// Review comments for the project workspace. Threads reload whenever the
// metadata poll reports a new comments version and after every mutation.
export function useComments({
  projectId,
  onShow,
}: {
  projectId: string;
  // Opens the Comments view.
  onShow: () => void;
}): Comments {
  const files = useProjectFiles();
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

  // The metadata poll reports a new version after anyone changes a comment.
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const run = useCallback(
    async <T>(action: () => Promise<T>) => {
      try {
        return await action();
      } finally {
        await refresh();
      }
    },
    [refresh],
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

import type { EditorView } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";

import type { CollaborativeFile } from "#/lib/collaboration/browser";
import {
  type CommentAnchor,
  createCommentAnchor,
  resolveCommentAnchor,
} from "#/lib/comments/anchor";
import {
  commentRanges,
  type CommentRange,
  setCommentRanges,
} from "#/lib/comments/editor";
import { commentQuote } from "#/lib/comments/project-comments.schema";

export type EditorComments = {
  threads: (CommentAnchor & { id: string })[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  // Absent for viewers, who read comments but cannot add them.
  onAdd?: (draft: CommentAnchor & { quote: string }) => void;
};

/**
 * Resolves anchored comment threads against the shared Yjs document, keeps
 * CodeMirror highlight ranges synced, and builds new anchors from the selection.
 */
export function useEditorComments({
  view,
  collaboration,
  comments,
  onError,
}: {
  view: EditorView | null;
  collaboration?: CollaborativeFile;
  comments?: EditorComments;
  onError: (message: string) => void;
}) {
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const commenting = !!comments && !!collaboration;
  const canAdd = commenting && !!comments.onAdd;
  const commentExtension = useMemo(
    () =>
      commenting
        ? commentRanges((id) => commentsRef.current?.onSelect(id))
        : [],
    [commenting],
  );
  const commentThreads = comments?.threads;
  const activeCommentId = comments?.activeId;

  // Resolves anchors against the shared document. An anchor stays unresolved
  // until its author's edits arrive, so retry on document updates until all
  // resolve.
  useEffect(() => {
    if (!view || !collaboration || !commentThreads) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      const ranges: CommentRange[] = [];
      let unresolved = false;
      for (const thread of commentThreads) {
        const range = resolveCommentAnchor(collaboration.text, thread);
        if (range) ranges.push({ id: thread.id, ...range });
        else unresolved = true;
      }
      view.dispatch({
        effects: setCommentRanges.of({ ranges, activeId: activeCommentId }),
      });
      return unresolved;
    };
    if (!apply()) return;
    const retry = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!apply()) collaboration.doc.off("update", retry);
      }, 250);
    };
    collaboration.doc.on("update", retry);
    return () => {
      clearTimeout(timer);
      collaboration.doc.off("update", retry);
    };
  }, [collaboration, commentThreads, activeCommentId, commentExtension, view]);

  function addComment() {
    if (!view || !collaboration || !comments?.onAdd) return;
    let { from, to } = view.state.selection.main;
    // Without a selection, comment on the cursor's line.
    if (from === to) ({ from, to } = view.state.doc.lineAt(from));
    if (from === to) {
      onError("Select the text you want to comment on.");
      return;
    }
    onError("");
    comments.onAdd({
      ...createCommentAnchor(collaboration.text, from, to),
      quote: commentQuote(view.state.sliceDoc(from, to)),
    });
  }

  return { canAdd, commentExtension, addComment };
}

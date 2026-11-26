import { IconCheck, IconDots, IconRestore } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";
import { Textarea } from "@texfolia/ui/textarea";
import { cn } from "cn";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import { type Confirmation, ConfirmDialog } from "#/components/confirm-dialog";
import type { CommentThread } from "#/hooks/use-comments";
import { resolveCommentAnchor } from "#/lib/comments/anchor";
import {
  createCommentThread,
  deleteComment,
  deleteCommentThread,
  replyToCommentThread,
  resolveCommentThread,
  updateComment,
} from "#/lib/comments/project-comments.functions";
import { maxCommentLength } from "#/lib/comments/project-comments.schema";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

type Filter = "open" | "resolved";
type Located = CommentThread & {
  path: string;
  range: { from: number; to: number } | null;
  line: number | null;
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function failureMessage(failure: unknown) {
  return failure instanceof Error
    ? failure.message
    : "Comments could not be updated. Try again.";
}

// Mod+Enter submits; Escape cancels.
function composerKeys(onSubmit: () => void, onCancel?: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };
}

export function ProjectComments() {
  const { holdDocument } = useWorkspaceActions();
  const { comments, collaboration, paths } = useWorkspace();
  const [filter, setFilter] = useState<Filter>("open");
  const threads = comments.data?.threads;
  // Positions resolve against the live documents of commented files.
  const commented = [...new Set((threads ?? []).map((thread) => thread.nodeId))]
    .sort()
    .join(" ");
  useEffect(() => {
    const releases = commented ? commented.split(" ").map(holdDocument) : [];
    return () => releases.forEach((release) => release());
  }, [commented, holdDocument]);
  const located = useMemo<Located[]>(() => {
    const texts = new Map<string, string>();
    return (threads ?? [])
      .map((thread) => {
        const text = collaboration.get(thread.nodeId)?.text;
        const range = text ? resolveCommentAnchor(text, thread) : null;
        let line: number | null = null;
        if (text && range) {
          let value = texts.get(thread.nodeId);
          if (value === undefined) {
            value = text.toString();
            texts.set(thread.nodeId, value);
          }
          line = value.slice(0, range.from).split("\n").length;
        }
        return {
          ...thread,
          path: paths.get(thread.nodeId) ?? "Unknown file",
          range,
          line,
        };
      })
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
    // Positions are read when the thread list or open files change.
  }, [threads, collaboration, paths]);

  const activeId = comments.activeId;
  const focusSequence = comments.focusSequence;
  useEffect(() => {
    if (!activeId || !focusSequence) return;
    // The editor gutter shows only open threads.
    setFilter("open");
    requestAnimationFrame(() => {
      const element = document.getElementById(`comment-thread-${activeId}`);
      element?.scrollIntoView({ block: "nearest" });
      element?.focus({ preventScroll: true });
    });
  }, [activeId, focusSequence]);

  const open = located.filter((thread) => !thread.resolvedAt);
  const resolved = located.filter((thread) => thread.resolvedAt);
  const shown = filter === "open" ? open : resolved;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div
        role="toolbar"
        aria-label="Comment filter"
        className="flex shrink-0 gap-1 border-b p-1"
      >
        {(
          [
            ["open", `Open (${open.length})`],
            ["resolved", `Resolved (${resolved.length})`],
          ] satisfies [Filter, string][]
        ).map(([value, label]) => (
          <Button
            key={value}
            size="xs"
            variant="ghost"
            aria-pressed={filter === value}
            className="aria-pressed:bg-muted flex-1"
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {comments.draft && <DraftComposer />}
        {comments.error && (
          <p role="alert" className="text-destructive p-2">
            {comments.error}
          </p>
        )}
        {!comments.data && !comments.error && (
          <p role="status" className="text-muted-foreground p-2">
            Loading comments…
          </p>
        )}
        {comments.data && !shown.length && !comments.draft && (
          <p className="text-muted-foreground p-3">
            {filter !== "open"
              ? "No resolved comments."
              : comments.data.canComment
                ? "No open comments. Select text in a file, then choose Add comment from the editor toolbar or context menu."
                : "No open comments. You can view this project but not comment on it."}
          </p>
        )}
        <ul className="divide-y">
          {shown.map((thread) => (
            <li key={thread.id}>
              <ThreadCard thread={thread} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DraftComposer() {
  const { projectId } = useWorkspaceActions();
  const { comments, paths } = useWorkspace();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draft = comments.draft;
  // A new selection starts a new draft.
  useEffect(() => {
    setBody("");
    setError("");
  }, [draft]);
  if (!draft) return null;
  const { cancelDraft, run, selectThread } = comments;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!draft || busy || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { threadId } = await run(() =>
        createCommentThread({
          data: { projectId, ...draft, body },
        }),
      );
      cancelDraft();
      selectThread(threadId);
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      aria-label="New comment"
      className="bg-muted/40 space-y-2 border-b p-2"
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-muted-foreground truncate">
        {paths.get(draft.nodeId)}
      </p>
      <Quote text={draft.quote} />
      <Textarea
        autoFocus
        aria-label="Comment"
        placeholder="Add a comment…"
        maxLength={maxCommentLength}
        value={body}
        disabled={busy}
        className="min-h-16 text-xs md:text-xs"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={composerKeys(() => void submit(), cancelDraft)}
      />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={cancelDraft}
        >
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={busy || !body.trim()}>
          {busy ? "Commenting…" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="text-muted-foreground border-highlight/60 line-clamp-3 border-l-2 pl-2 font-mono whitespace-pre-wrap">
      {text}
    </blockquote>
  );
}

function ThreadCard({ thread }: { thread: Located }) {
  const { projectId, revealRange } = useWorkspaceActions();
  const { comments } = useWorkspace();
  const [reply, setReply] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!comments.data) return null;
  const { data, run, selectThread, activeId } = comments;
  const active = activeId === thread.id;
  // Google Docs rules: commenters resolve any thread and manage their own
  // comments; editors also delete anyone's; viewers only read.
  const canDelete =
    data.canModerate || (data.canComment && thread.createdBy === data.userId);
  // The anchored text was deleted when its range collapsed.
  const detached =
    thread.range !== null && thread.range.from === thread.range.to;

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run(action);
      return true;
    } catch (failure) {
      setError(failureMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submitReply(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !reply.trim()) return;
    if (
      await act(() =>
        replyToCommentThread({
          data: { projectId, threadId: thread.id, body: reply },
        }),
      )
    )
      setReply("");
  }
  function show() {
    selectThread(thread.id);
    if (thread.range) revealRange(thread.nodeId, thread.range);
  }

  return (
    <article
      id={`comment-thread-${thread.id}`}
      tabIndex={-1}
      aria-label={`Comment on ${thread.path}`}
      aria-current={active || undefined}
      className={cn(
        "space-y-2 p-2 outline-none",
        active && "bg-muted/60 ring-ring/50 ring-2 ring-inset",
      )}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          className="hover:bg-muted focus-visible:ring-ring min-w-0 flex-1 space-y-1 rounded-md p-1 text-left outline-none focus-visible:ring-2"
          onClick={show}
        >
          <span className="text-muted-foreground block truncate">
            {thread.path}
            {thread.line !== null && `:${thread.line}`}
            {thread.range === null && " · position unavailable"}
            {detached && " · text deleted"}
          </span>
          <Quote text={thread.quote} />
        </button>
        {data.canComment && (
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={busy}
            aria-label={thread.resolvedAt ? "Reopen thread" : "Resolve thread"}
            title={thread.resolvedAt ? "Reopen" : "Resolve"}
            onClick={() =>
              void act(() =>
                resolveCommentThread({
                  data: {
                    projectId,
                    threadId: thread.id,
                    resolved: !thread.resolvedAt,
                  },
                }),
              )
            }
          >
            {thread.resolvedAt ? <IconRestore /> : <IconCheck />}
          </Button>
        )}
        {canDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" />}
              aria-label="Thread actions"
              title="Thread actions"
              disabled={busy}
            >
              <IconDots />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  setConfirmation({
                    title: "Delete thread?",
                    description:
                      "This deletes the thread and all of its replies for everyone.",
                    action: "Delete thread",
                    onConfirm: () =>
                      void act(() =>
                        deleteCommentThread({
                          data: { projectId, threadId: thread.id },
                        }),
                      ),
                  })
                }
              >
                Delete thread
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {thread.resolvedAt && (
        <p className="text-muted-foreground">
          Resolved{thread.resolvedByName && ` by ${thread.resolvedByName}`} ·{" "}
          {dateFormat.format(thread.resolvedAt)}
        </p>
      )}
      <ol className="space-y-2">
        {thread.comments.map((comment) => (
          <li key={comment.id}>
            <CommentItem
              comment={comment}
              canEdit={data.canComment && comment.authorId === data.userId}
              canDelete={
                data.canModerate ||
                (data.canComment && comment.authorId === data.userId)
              }
              onUpdate={(body) =>
                act(() =>
                  updateComment({
                    data: { projectId, commentId: comment.id, body },
                  }),
                )
              }
              onDelete={() =>
                setConfirmation({
                  title: "Delete comment?",
                  description: "This deletes the comment for everyone.",
                  action: "Delete comment",
                  onConfirm: () =>
                    void act(() =>
                      deleteComment({
                        data: { projectId, commentId: comment.id },
                      }),
                    ),
                })
              }
              busy={busy}
            />
          </li>
        ))}
      </ol>
      {data.canComment && (
        <form
          aria-label="Reply"
          className="space-y-1"
          onSubmit={(event) => void submitReply(event)}
        >
          <Textarea
            aria-label="Reply"
            placeholder={thread.resolvedAt ? "Reply to reopen…" : "Reply…"}
            maxLength={maxCommentLength}
            value={reply}
            disabled={busy}
            className="min-h-8 py-1 text-xs md:text-xs"
            onFocus={() => selectThread(thread.id)}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={composerKeys(
              () => void submitReply(),
              () => setReply(""),
            )}
          />
          {reply.trim() && (
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setReply("")}
              >
                Cancel
              </Button>
              <Button type="submit" size="xs" disabled={busy}>
                Reply
              </Button>
            </div>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        confirmation={confirmation}
        onClose={() => setConfirmation(null)}
      />
    </article>
  );
}

function CommentItem({
  comment,
  canEdit,
  canDelete,
  busy,
  onUpdate,
  onDelete,
}: {
  comment: CommentThread["comments"][number];
  canEdit: boolean;
  canDelete: boolean;
  busy: boolean;
  onUpdate: (body: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (editing === null || !editing.trim()) return;
    if (editing === comment.body || (await onUpdate(editing))) setEditing(null);
  }
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1">
        <span className="min-w-0 truncate font-medium">
          {comment.authorName}
        </span>
        <span className="text-muted-foreground shrink-0">
          {dateFormat.format(comment.createdAt)}
          {comment.editedAt && " (edited)"}
        </span>
        {(canEdit || canDelete) && editing === null && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" className="ml-auto" />
              }
              aria-label="Comment actions"
              title="Comment actions"
              disabled={busy}
            >
              <IconDots />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {canEdit && (
                <DropdownMenuItem onClick={() => setEditing(comment.body)}>
                  Edit
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing === null ? (
        <p className="wrap-anywhere whitespace-pre-wrap">{comment.body}</p>
      ) : (
        <form
          aria-label="Edit comment"
          className="space-y-1"
          onSubmit={(event) => void save(event)}
        >
          <Textarea
            autoFocus
            aria-label="Comment"
            maxLength={maxCommentLength}
            value={editing}
            disabled={busy}
            className="min-h-8 py-1 text-xs md:text-xs"
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={composerKeys(
              () => void save(),
              () => setEditing(null),
            )}
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={busy || !editing.trim()}>
              Save
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

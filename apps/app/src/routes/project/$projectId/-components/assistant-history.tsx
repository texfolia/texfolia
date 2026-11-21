import { IconDots, IconPlus, IconX } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import {
  threadSchema,
  threadHistorySchema,
  type AssistantThread,
  type StoredMessage,
} from "#/lib/ai/threads";

import { SidebarResize } from "./sidebar-resize";

export async function assistantJson(
  url: string,
  action?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(
    url,
    action
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
          signal,
        }
      : { signal },
  );
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(
      parsed.success ? parsed.data.error : "Could not load chats. Try again.",
    );
  }
  return body;
}

export function AssistantHistory({
  projectId,
  children,
  historyOpen,
  historyWidth,
  agentsOpen,
  agentsWidth,
  onHistoryToggle,
  onHistoryResize,
  onShowAgents,
  onCloseAgents,
}: {
  historyOpen: boolean;
  historyWidth: number;
  agentsOpen: boolean;
  agentsWidth: number;
  onHistoryToggle: () => void;
  onHistoryResize: (width: number) => void;
  onShowAgents: () => void;
  onCloseAgents: () => void;
  projectId: string;
  children: (
    thread: AssistantThread,
    messages: StoredMessage[],
    onBusy: (busy: boolean) => void,
    onRefresh: () => void,
  ) => ReactNode;
}) {
  const endpoint = `/api/ai/${projectId}?threads=1`;
  const [threads, setThreads] = useState<AssistantThread[]>([]);
  const [selected, setSelected] =
    useState<z.infer<typeof threadHistorySchema>>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mutation, setMutation] = useState(false);
  const [dialog, setDialog] = useState<{
    kind: "rename" | "delete";
    thread: AssistantThread;
  }>();
  const [title, setTitle] = useState("");
  const loadSequence = useRef(0);
  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      const data = z
        .object({ threads: z.array(threadSchema) })
        .parse(await assistantJson(endpoint, undefined, signal));
      setThreads(data.threads);
      return data.threads;
    },
    [endpoint],
  );
  const open = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const sequence = ++loadSequence.current;
      setLoading(true);
      setError("");
      try {
        const data = threadHistorySchema.parse(
          await assistantJson(`${endpoint}&thread=${id}`, undefined, signal),
        );
        if (sequence === loadSequence.current) setSelected(data);
      } catch (failure) {
        if (!signal?.aborted)
          setError(
            failure instanceof Error ? failure.message : "Could not load chat.",
          );
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    },
    [endpoint],
  );
  useEffect(() => {
    const abort = new AbortController();
    void loadList(abort.signal)
      .then(async (list) => {
        if (abort.signal.aborted) return;
        if (list[0]) await open(list[0].id, abort.signal);
        else setLoading(false);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setLoading(false);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load chats.",
          );
        }
      });
    return () => {
      abort.abort();
      loadSequence.current++;
    };
  }, [loadList, open]);
  async function create() {
    setLoading(true);
    setMutation(true);
    setError("");
    try {
      const data = threadHistorySchema.parse(
        await assistantJson(endpoint, { kind: "create" }),
      );
      setSelected(data);
      await loadList();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not create chat.",
      );
    } finally {
      setMutation(false);
      setLoading(false);
    }
  }
  const refresh = useCallback(() => {
    void loadList().catch(() => {});
  }, [loadList]);
  return (
    <div className="flex h-full min-w-0 max-md:w-full">
      <aside
        aria-label="Agent history"
        hidden={!historyOpen}
        style={{ width: historyWidth }}
        className="bg-sidebar flex min-w-0 shrink-0 flex-col max-md:w-full! [&[hidden]]:hidden"
      >
        <header className="flex h-9 shrink-0 items-center justify-between border-b px-2">
          <h2 className="text-xs font-medium">Chat history</h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close chat history"
            onClick={onHistoryToggle}
          >
            <IconX />
          </Button>
        </header>
        <nav
          aria-label="Chat history"
          className="min-h-0 flex-1 space-y-0.5 overflow-auto p-1"
        >
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="group/thread flex min-w-0 items-center gap-1"
            >
              <Button
                variant={
                  selected?.thread.id === thread.id ? "secondary" : "ghost"
                }
                size="sm"
                disabled={busy || mutation}
                aria-current={
                  selected?.thread.id === thread.id ? "true" : undefined
                }
                className="min-w-0 flex-1 justify-start"
                onClick={() => {
                  onShowAgents();
                  void open(thread.id);
                }}
              >
                <span className="truncate">{thread.title}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon-xs" />}
                  disabled={busy || mutation}
                  className="opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 max-md:opacity-100"
                  aria-label={`Manage chat ${thread.title}`}
                >
                  <IconDots />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onClick={() => {
                      setTitle(thread.title);
                      setDialog({ kind: "rename", thread });
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDialog({ kind: "delete", thread })}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </nav>
      </aside>
      {historyOpen && agentsOpen && (
        <SidebarResize
          side="left"
          width={historyWidth}
          onResize={onHistoryResize}
          label="Resize history sidebar"
        />
      )}
      <aside
        aria-label="AI assistant"
        hidden={!agentsOpen}
        style={{ width: agentsWidth }}
        className="bg-sidebar flex min-w-0 shrink-0 flex-col max-md:w-full! [&[hidden]]:hidden"
      >
        <header className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
          <h2
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={selected?.thread.title}
          >
            {selected?.thread.title ?? "Agents"}
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New chat"
            disabled={busy || mutation}
            onClick={() => void create()}
          >
            <IconPlus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close assistant"
            onClick={onCloseAgents}
          >
            <IconX />
          </Button>
        </header>
        {error && (
          <div className="p-3">
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void loadList()
                  .then((list) => list[0] && open(list[0].id))
                  .catch((failure) => setError(String(failure)));
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {loading ? (
          <p role="status" className="p-3 text-sm">
            Loading chat…
          </p>
        ) : selected ? (
          children(selected.thread, selected.messages, setBusy, refresh)
        ) : (
          <div className="space-y-3 p-4 text-sm">
            <p>Your chats are saved here, privately for this project.</p>
            <Button size="sm" disabled={mutation} onClick={() => void create()}>
              Start a chat
            </Button>
          </div>
        )}
      </aside>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !mutation) setDialog(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "delete" ? "Delete chat" : "Rename chat"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "delete"
                ? `Delete “${dialog.thread.title}” and its messages? This cannot be undone.`
                : "Choose a name for this conversation."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!dialog) return;
              setMutation(true);
              setError("");
              try {
                await assistantJson(endpoint, {
                  kind: dialog.kind,
                  id: dialog.thread.id,
                  ...(dialog.kind === "rename" ? { title } : {}),
                });
                const list = await loadList();
                if (selected?.thread.id === dialog.thread.id) {
                  if (dialog.kind === "delete") {
                    setSelected(undefined);
                    if (list[0]) await open(list[0].id);
                  } else
                    setSelected(
                      (current) =>
                        current && {
                          ...current,
                          thread: { ...current.thread, title },
                        },
                    );
                }
                setDialog(undefined);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not update chat.",
                );
              } finally {
                setMutation(false);
              }
            }}
          >
            {dialog?.kind === "rename" && (
              <Input
                aria-label="Chat name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                required
                autoFocus
              />
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={mutation}
                onClick={() => setDialog(undefined)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={dialog?.kind === "delete" ? "destructive" : "default"}
                disabled={mutation}
              >
                {mutation
                  ? "Saving…"
                  : dialog?.kind === "delete"
                    ? "Delete"
                    : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

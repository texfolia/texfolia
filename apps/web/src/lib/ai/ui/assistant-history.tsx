import { IconDots, IconPlus, IconX } from "@tabler/icons-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { Store } from "#/lib/external-store";

import type { AssistantThread } from "../threads";
import { AssistantThreadContext } from "./assistant-thread";
import { ThreadDialog, type ThreadRequest } from "./thread-dialog";
import { useAssistantThreads } from "./use-assistant-threads";

/** The list of chats beside the open one, which the children render. */
export function AssistantHistory({
  endpoint,
  prompt,
  children,
  historyOpen,
  historyWidth,
  agentsOpen,
  agentsWidth,
  historyResize,
  onHistoryToggle,
  onShowAgents,
  onCloseAgents,
}: {
  historyOpen: boolean;
  historyWidth: number;
  agentsOpen: boolean;
  agentsWidth: number;
  historyResize: ReactNode;
  onHistoryToggle: () => void;
  onShowAgents: () => void;
  onCloseAgents: () => void;
  endpoint: string;
  /** A request from the editor, which starts a chat when there is none. */
  prompt: Store<string | null>;
  /** Rendered with the open chat in AssistantThreadContext. */
  children: ReactNode;
}) {
  const chats = useAssistantThreads(endpoint, prompt);
  const { selected, error, mutating, refresh } = chats;
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<ThreadRequest>();
  const openThread = useMemo(
    () =>
      selected && {
        thread: selected.thread,
        initialMessages: selected.messages,
        onBusy: setBusy,
        onRefresh: refresh,
      },
    [selected, refresh],
  );
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
          {chats.threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              current={selected?.thread.id === thread.id}
              disabled={busy || mutating}
              onOpen={() => {
                onShowAgents();
                void chats.open(thread.id);
              }}
              onRequest={setRequest}
            />
          ))}
          {chats.more && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={chats.loadingMore}
              onClick={() => void chats.loadMore()}
            >
              {chats.loadingMore ? "Loading…" : "Show more"}
            </Button>
          )}
        </nav>
      </aside>
      {historyOpen && agentsOpen && historyResize}
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
            disabled={busy || mutating}
            onClick={() => void chats.create()}
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
            <Button variant="ghost" size="xs" onClick={chats.retry}>
              Try again
            </Button>
          </div>
        )}
        {chats.loading ? (
          <p role="status" className="p-3 text-sm">
            Loading chat…
          </p>
        ) : openThread ? (
          <AssistantThreadContext key={openThread.thread.id} value={openThread}>
            {children}
          </AssistantThreadContext>
        ) : (
          <div className="space-y-3 p-4 text-sm">
            <p>Your chats are saved here, privately for this project.</p>
            <Button
              size="sm"
              disabled={mutating}
              onClick={() => void chats.create()}
            >
              Start a chat
            </Button>
          </div>
        )}
      </aside>
      <ThreadDialog
        request={request}
        saving={mutating}
        onSubmit={(thread, title) =>
          void chats.change(thread, title).then((changed) => {
            if (changed) setRequest(undefined);
          })
        }
        onClose={() => setRequest(undefined)}
      />
    </div>
  );
}

function ThreadItem({
  thread,
  current,
  disabled,
  onOpen,
  onRequest,
}: {
  thread: AssistantThread;
  current: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRequest: (request: ThreadRequest) => void;
}) {
  return (
    <div className="group/thread flex min-w-0 items-center gap-1">
      <Button
        variant={current ? "secondary" : "ghost"}
        size="sm"
        disabled={disabled}
        aria-current={current ? "true" : undefined}
        className="min-w-0 flex-1 justify-start"
        onClick={onOpen}
      >
        <span className="truncate">{thread.title}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-xs" />}
          disabled={disabled}
          className="opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 max-md:opacity-100"
          aria-label={`Manage chat ${thread.title}`}
        >
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onClick={() => onRequest({ kind: "rename", thread })}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onRequest({ kind: "delete", thread })}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

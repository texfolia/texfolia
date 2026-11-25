import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { z } from "zod";

import type { Store } from "#/lib/external-store";

import {
  type AssistantThread,
  threadHistorySchema,
  threadListSchema,
  threadPageSize,
} from "../threads";
import { assistantJson, failureMessage } from "./assistant-client";

/** The user's chats in a project, and the one that is open. */
export function useAssistantThreads(
  assistantEndpoint: string,
  /** A request from the editor, which starts a chat when there is none. */
  prompt: Store<string | null>,
) {
  const endpoint = `${assistantEndpoint}?threads=1`;
  const [threads, setThreads] = useState<AssistantThread[]>([]);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Reloading the list keeps as many chats as were loaded.
  const listed = useRef(threadPageSize);
  const [selected, setSelected] =
    useState<z.infer<typeof threadHistorySchema>>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const loadSequence = useRef(0);
  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      const data = threadListSchema.parse(
        await assistantJson(
          `${endpoint}&limit=${listed.current}`,
          undefined,
          signal,
        ),
      );
      setThreads(data.threads);
      setMore(data.more);
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
          setError(failureMessage(failure, "Could not load chat."));
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
          setError(failureMessage(failure, "Could not load chats."));
        }
      });
    return () => {
      abort.abort();
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- A counter, not an element: it must be the latest one.
      loadSequence.current++;
    };
  }, [loadList, open]);

  async function create() {
    setLoading(true);
    setMutating(true);
    setError("");
    try {
      const data = threadHistorySchema.parse(
        await assistantJson(endpoint, { kind: "create" }),
      );
      setSelected(data);
      await loadList();
    } catch (failure) {
      setError(failureMessage(failure, "Could not create chat."));
    } finally {
      setMutating(false);
      setLoading(false);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    setError("");
    listed.current += threadPageSize;
    try {
      await loadList();
    } catch (failure) {
      listed.current -= threadPageSize;
      setError(failureMessage(failure, "Could not load chats."));
    } finally {
      setLoadingMore(false);
    }
  }

  /** Renames a chat, or deletes it when there is no title. Resolves to whether it did. */
  async function change(thread: AssistantThread, title?: string) {
    setMutating(true);
    setError("");
    try {
      await assistantJson(endpoint, {
        kind: title === undefined ? "delete" : "rename",
        id: thread.id,
        title,
      });
      const list = await loadList();
      if (selected?.thread.id === thread.id) {
        if (title === undefined) {
          setSelected(undefined);
          if (list[0]) await open(list[0].id);
        } else
          setSelected(
            (current) =>
              current && { ...current, thread: { ...current.thread, title } },
          );
      }
      return true;
    } catch (failure) {
      setError(failureMessage(failure, "Could not update chat."));
      return false;
    } finally {
      setMutating(false);
    }
  }

  function retry() {
    void loadList()
      .then((list) => list[0] && open(list[0].id))
      .catch((failure) => setError(String(failure)));
  }

  const requested = useSyncExternalStore(prompt.subscribe, prompt.get) !== null;
  const startRequested = useEffectEvent(() => {
    if (!selected && !mutating && !error) void create();
  });
  useEffect(() => {
    if (requested && !loading) startRequested();
  }, [requested, loading]);
  const refresh = useCallback(() => {
    void loadList().catch(() => {});
  }, [loadList]);

  return {
    threads,
    more,
    loadingMore,
    selected,
    error,
    loading,
    mutating,
    open,
    create,
    loadMore,
    change,
    retry,
    refresh,
  };
}

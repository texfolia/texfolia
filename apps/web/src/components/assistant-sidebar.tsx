import { IconPlus, IconX } from "@tabler/icons-react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { Markdown } from "@tanstack/markdown/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { aiConfigurationSchema, type AiConfiguration } from "#/lib/ai/schema";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
type Availability =
  | { kind: "loading" }
  | { kind: "ready"; config: AiConfiguration }
  | { kind: "unavailable"; message: string; upgrade: boolean };

export function AssistantSidebar({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [availability, setAvailability] = useState<Availability>({
    kind: "loading",
  });
  const endpoint = `/api/ai/${projectId}`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(endpoint, { signal });
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsed = z.object({ error: z.string() }).safeParse(body);
          setAvailability({
            kind: "unavailable",
            message: parsed.success
              ? parsed.data.error
              : "The assistant could not load. Try again.",
            upgrade: response.status === 403,
          });
          return;
        }
        setAvailability({
          kind: "ready",
          config: aiConfigurationSchema.parse(body),
        });
      } catch {
        if (!signal?.aborted)
          setAvailability({
            kind: "unavailable",
            message:
              "The assistant could not connect. Check your connection and try again.",
            upgrade: false,
          });
      }
    },
    [endpoint],
  );
  const refreshConfiguration = useCallback(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  return (
    <aside
      aria-label="AI assistant"
      hidden={!open}
      className="bg-sidebar text-sidebar-foreground absolute inset-y-0 left-0 z-30 flex w-[min(22rem,100%)] min-w-0 flex-col border-r lg:relative lg:w-80 lg:shrink-0 [&[hidden]]:hidden"
    >
      <header className="flex min-h-9 items-center gap-2 border-b px-3">
        <h2 className="flex-1 text-xs font-medium">Assistant</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close assistant"
          onClick={onClose}
        >
          <IconX />
        </Button>
      </header>
      {availability.kind === "loading" && (
        <p role="status" className="p-4 text-sm">
          Loading assistant…
        </p>
      )}
      {availability.kind === "unavailable" && (
        <div className="space-y-4 p-4 text-sm">
          <p role="status">{availability.message}</p>
          {availability.upgrade ? (
            <Button render={<Link to="/pricing" />}>View Pro plans</Button>
          ) : (
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          )}
        </div>
      )}
      {availability.kind === "ready" && (
        <AssistantChat
          projectId={projectId}
          config={availability.config}
          onConfiguration={(config) =>
            setAvailability({ kind: "ready", config })
          }
          refresh={refreshConfiguration}
        />
      )}
    </aside>
  );
}

function AssistantChat({
  projectId,
  config,
  onConfiguration,
  refresh,
}: {
  projectId: string;
  config: AiConfiguration;
  onConfiguration: (config: AiConfiguration) => void;
  refresh: () => void;
}) {
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState(() => crypto.randomUUID());
  const defaultModel =
    config.models.find((m) => m.id === config.defaultModel)?.id ??
    config.models[0]?.id ??
    "";
  const [model, setModel] = useState(defaultModel);
  const [cap, setCap] = useState(String(config.monthlyCapDollars));
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const connection = useMemo(
    () => fetchServerSentEvents(`/api/ai/${projectId}`),
    [projectId],
  );
  const { messages, sendMessage, isLoading, error, stop, clear } = useChat({
    connection,
    threadId,
    onResponse: async (response) => {
      if (!response || response.ok) return;
      const parsed = z.object({ error: z.string() }).safeParse(
        await response
          .clone()
          .json()
          .catch(() => null),
      );
      if (parsed.success) throw new Error(parsed.data.error);
    },
  });
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, isLoading]);
  useEffect(() => {
    if (!isLoading) refresh();
  }, [isLoading, refresh]);
  useEffect(() => {
    if (!config.pendingRequests || isLoading) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/ai/${projectId}?reconcile=1`, {
          method: "POST",
          signal: abort.signal,
        });
        if (response.ok)
          onConfiguration(aiConfigurationSchema.parse(await response.json()));
      } catch {
        // The scheduled reconciler also owns retries when the browser is offline.
      }
    }, 10_000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [config, isLoading, projectId, onConfiguration]);
  const selected = config.models.find((m) => m.id === model);
  const remaining =
    config.monthlyCapDollars - config.spentDollars - config.reservedDollars;
  async function savePreferences() {
    setSaving(true);
    setSettingsError("");
    setSettingsSaved(false);
    try {
      const response = await fetch(`/api/ai/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: model || null,
          monthlyCapDollars: Number(cap),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = z.object({ error: z.string() }).safeParse(body);
        throw new Error(
          parsed.success ? parsed.data.error : "Could not save AI settings.",
        );
      }
      onConfiguration(aiConfigurationSchema.parse(body));
      setSettingsSaved(true);
    } catch (error) {
      setSettingsError(
        error instanceof Error
          ? error.message
          : "Could not save settings. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <label className="sr-only" htmlFor="assistant-model">
          Model for this chat
        </label>
        <select
          id="assistant-model"
          className="bg-sidebar focus-visible:outline-ring min-w-0 flex-1 border px-2 py-1 text-xs focus-visible:outline-2"
          value={model}
          disabled={isLoading}
          onChange={(event) => setModel(event.target.value)}
        >
          {config.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New chat"
          disabled={isLoading}
          onClick={() => {
            clear();
            setThreadId(crypto.randomUUID());
            setInput("");
            setModel(defaultModel);
          }}
        >
          <IconPlus />
        </Button>
      </div>
      <details className="shrink-0 border-b px-3 py-2 text-xs">
        <summary className="focus-visible:outline-ring cursor-pointer focus-visible:outline-2">
          {dollars.format(config.spentDollars)} used ·{" "}
          {dollars.format(config.monthlyCapDollars)} monthly cap
        </summary>
        <div className="space-y-3 py-3">
          <p>
            AI is billed monthly at model cost plus 20%. Failed and stopped
            requests may still incur usage.
          </p>
          {config.reservedDollars > 0 && (
            <p role="status">
              {dollars.format(config.reservedDollars)} reserved while usage
              settles.
            </p>
          )}
          {config.needsReview && (
            <p role="status">
              Some usage needs a billing review. Its reservation stays in place
              until resolved.
            </p>
          )}
          {selected && (
            <p className="tabular-nums">
              Per million tokens:{" "}
              {dollars.format(selected.inputPrice * 1_000_000 * 1.2)} input ·{" "}
              {dollars.format(selected.outputPrice * 1_000_000 * 1.2)} output,
              including markup.
            </p>
          )}
          <label className="flex items-center justify-between gap-3">
            Monthly cap (USD)
            <input
              aria-label="Monthly AI spend cap"
              className="bg-background focus-visible:outline-ring w-24 border px-2 py-1 tabular-nums focus-visible:outline-2"
              type="number"
              min="0"
              max="10000"
              step="0.01"
              value={cap}
              onChange={(event) => {
                setCap(event.target.value);
                setSettingsSaved(false);
              }}
            />
          </label>
          <p>
            Save to make the selected model your default for new chats. A $0 cap
            pauses AI.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void savePreferences()}
          >
            {saving ? "Saving…" : "Save AI preferences"}
          </Button>
          {settingsError && <p role="alert">{settingsError}</p>}
          {settingsSaved && <p role="status">AI preferences saved.</p>}
        </div>
      </details>
      <div
        aria-label="Conversation"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-0 flex-1 space-y-6 overflow-auto p-3 text-sm"
      >
        {messages.length === 0 && (
          <div className="space-y-3 py-4">
            <p className="font-medium">Work on your LaTeX project</p>
            <p className="text-muted-foreground leading-relaxed">
              Ask for a revision, fix a LaTeX error, or check a build. The
              assistant can read files, save edits, and compile your project.
            </p>
            <p className="text-muted-foreground text-xs">
              Edits appear immediately for everyone in the project. This chat
              lasts until you leave the page.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className="min-w-0 space-y-2 wrap-anywhere">
            <h3 className="text-xs font-medium">
              {message.role === "user" ? "You" : "Assistant"}
            </h3>
            {message.parts.map((part, index) => {
              if (part.type === "text")
                return (
                  <div
                    key={index}
                    className="[&_pre]:bg-muted leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_code]:font-mono [&_code]:text-xs [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:p-2 [&_ul]:list-disc"
                  >
                    <Markdown>{part.content}</Markdown>
                  </div>
                );
              if (part.type === "tool-call")
                return (
                  <details key={part.id} className="border-y py-2 text-xs">
                    <summary className="cursor-pointer">
                      {part.name.replaceAll("_", " ")} ·{" "}
                      {part.state.replaceAll("-", " ")}
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                      {part.arguments}
                    </pre>
                  </details>
                );
              if (part.type === "tool-result")
                return (
                  <details
                    key={part.toolCallId}
                    className="text-muted-foreground text-xs"
                  >
                    <summary className="cursor-pointer">
                      Tool result · {part.state}
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                      {typeof part.content === "string"
                        ? part.content
                        : JSON.stringify(part.content)}
                    </pre>
                  </details>
                );
              return null;
            })}
          </article>
        ))}
        {isLoading && (
          <p role="status" className="text-muted-foreground text-xs">
            Assistant is working…
          </p>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="shrink-0 space-y-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim() || isLoading) return;
          const content = input;
          setInput("");
          void sendMessage(content, { body: { model } });
        }}
      >
        {error && (
          <p role="alert" className="text-destructive text-xs wrap-anywhere">
            {error.message}
          </p>
        )}
        {!config.models.length && (
          <p role="status" className="text-xs">
            No models with tool support are available. Try again later.
          </p>
        )}
        {remaining <= 0 && (
          <p role="status" className="text-xs">
            Monthly cap reached or reserved. Adjust your cap above, or wait for
            usage to settle.
          </p>
        )}
        <label className="sr-only" htmlFor="assistant-message">
          Message the assistant
        </label>
        <Textarea
          id="assistant-message"
          className="max-h-40 rounded-none"
          placeholder="Ask about this project…"
          value={input}
          maxLength={32 * 1024}
          disabled={!selected || remaining <= 0}
          onChange={(event) => setInput(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">
            Usage billed to your plan
          </span>
          {isLoading ? (
            <Button type="button" size="sm" variant="outline" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={!input.trim() || !selected || remaining <= 0}
            >
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

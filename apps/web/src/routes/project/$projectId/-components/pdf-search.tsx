import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import { useEffect, useRef } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";

import type { usePdfSearch } from "../-hooks/use-pdf-search";

export function PdfSearch({
  search,
  focusRequest,
  onClose,
}: {
  search: ReturnType<typeof usePdfSearch>;
  /** Changes to focus the query again. */
  focusRequest: number;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);
  const none = !search.matches.length;
  return (
    <div
      role="search"
      aria-label="Find in PDF"
      className="flex shrink-0 items-center gap-1 border-b px-2 py-1"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <Input
        ref={input}
        aria-label="Find in PDF"
        placeholder="Find in PDF"
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          search.step(event.shiftKey ? -1 : 1);
        }}
        className="h-6 min-w-0 flex-1 px-2 text-xs"
      />
      <span
        role="status"
        className="text-muted-foreground shrink-0 text-xs tabular-nums"
      >
        {search.status}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={none}
        onClick={() => search.step(-1)}
      >
        <IconChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={none}
        onClick={() => search.step(1)}
      >
        <IconChevronDown />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close search"
        onClick={onClose}
      >
        <IconX />
      </Button>
    </div>
  );
}

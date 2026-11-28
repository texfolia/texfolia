import { Avatar, AvatarFallback, AvatarImage } from "@texfolia/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";
import { cn } from "cn";
import { Fragment } from "react";

import { parseMentions, type ResolvedMention } from "#/lib/mentions/tokens";

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
}

export function MentionChip({
  mention,
  fallbackName,
  interactive = true,
  className,
}: {
  mention?: ResolvedMention;
  fallbackName: string;
  interactive?: boolean;
  className?: string;
}) {
  const status = mention?.status ?? "active";
  const displayName = mention?.name ?? fallbackName;
  const isHistorical = status !== "active";
  const statusLabel =
    status === "active"
      ? "Project collaborator"
      : status === "former"
        ? "No longer has access to this project"
        : "Account deleted";

  const chipClasses = cn(
    "inline-flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 align-baseline text-[0.95em] font-medium leading-tight",
    isHistorical
      ? "bg-muted text-muted-foreground"
      : "bg-primary/12 text-primary hover:bg-primary/20",
    interactive &&
      "focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2",
    className,
  );

  const inner = (
    <>
      {!isHistorical && (
        <Avatar size="sm" className="size-3.5 shrink-0">
          {mention?.image && <AvatarImage src={mention.image} alt="" />}
          <AvatarFallback className="text-[8px]">
            {initialsOf(displayName)}
          </AvatarFallback>
        </Avatar>
      )}
      <span className="truncate">@{displayName}</span>
    </>
  );

  if (!interactive) {
    return (
      <span
        data-mention-status={status}
        className={chipClasses}
        title={isHistorical ? statusLabel : displayName}
      >
        {inner}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`@${displayName}`}
            data-mention-status={status}
            className={chipClasses}
          />
        }
      >
        {inner}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <Avatar size="sm" className="size-7 shrink-0">
            {!isHistorical && mention?.image && (
              <AvatarImage src={mention.image} alt="" />
            )}
            <AvatarFallback className="text-[10px]">
              {isHistorical ? "?" : initialsOf(displayName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-foreground truncate text-xs font-medium">
              {displayName}
            </p>
            <p className="text-muted-foreground text-[11px]">{statusLabel}</p>
          </div>
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renders text containing structured `@[Name](mention:id)` tokens as inline chips. */
export function MentionText({
  text,
  mentions,
}: {
  text: string;
  mentions?: Readonly<Record<string, ResolvedMention>>;
}) {
  const segments = parseMentions(text);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <MentionChip
            key={`${segment.userId}-${segment.from}`}
            mention={mentions?.[segment.userId]}
            fallbackName={segment.fallbackName}
          />
        ),
      )}
    </>
  );
}

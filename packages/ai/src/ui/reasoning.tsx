import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@texfolia/ui/trace";

export function Reasoning({
  text,
  running,
}: {
  text: string;
  running: boolean;
}) {
  return (
    <Trace>
      <TraceCollapsible defaultOpen={running}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? "running" : undefined}>
            <TraceTitle>{running ? "Thinking…" : "Reasoning"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="text-muted-foreground whitespace-pre-wrap">
          {text}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

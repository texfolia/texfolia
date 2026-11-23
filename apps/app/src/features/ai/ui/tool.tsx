import { IconTool } from "@tabler/icons-react";
import type { ToolCallPart, ToolResultPart } from "@tanstack/ai";
import { CodeBlock, CodeBlockContent } from "@texfolia/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
} from "@texfolia/ui/trace";

function ToolValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth > 6) return <p className="text-muted-foreground">Nested result</p>;
  if (typeof value === "string") {
    if (value.includes("\n"))
      return (
        <CodeBlock size="sm">
          <CodeBlockContent wrap className="max-h-64">
            {value}
          </CodeBlockContent>
        </CodeBlock>
      );
    return <span className="wrap-anywhere">{value}</span>;
  }
  if (Array.isArray(value))
    return (
      <ul className="space-y-1">
        {value.map((item, index) => (
          <li key={index}>
            <ToolValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  if (value && typeof value === "object")
    return (
      <dl className="space-y-2">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt className="text-muted-foreground mb-0.5 font-medium">
              {key.replaceAll("_", " ")}
            </dt>
            <dd>
              <ToolValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span>{value === null || value === undefined ? "—" : String(value)}</span>
  );
}
function structured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// The current shadcn Tool pattern is a Trace with structured input and output.
export function Tool({
  part,
  result,
  running,
}: {
  part: ToolCallPart;
  result?: ToolResultPart;
  running: boolean;
}) {
  const failed = result?.state === "error" || part.state === "error";
  const complete = !!result || part.state === "complete";
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={
              failed ? "error" : running && !complete ? "running" : undefined
            }
          >
            <TraceIcon>
              <IconTool />
            </TraceIcon>
            <TraceTitle>
              {part.name.replaceAll("_", " ")} ·{" "}
              {failed
                ? "Failed"
                : complete
                  ? "Complete"
                  : running
                    ? "Running"
                    : "Stopped"}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="space-y-3 text-xs">
          <div>
            <p className="mb-2 font-medium">Input</p>
            {part.state === "awaiting-input" ||
            part.state === "input-streaming" ? (
              <p className="shimmer motion-reduce:shimmer-none">
                Receiving input…
              </p>
            ) : (
              <ToolValue value={part.input ?? structured(part.arguments)} />
            )}
          </div>
          {(result || part.output !== undefined) && (
            <div>
              <p className="mb-2 font-medium">Result</p>
              <ToolValue
                value={structured(
                  result?.error ?? result?.content ?? part.output,
                )}
              />
            </div>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

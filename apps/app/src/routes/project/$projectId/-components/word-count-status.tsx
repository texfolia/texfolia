import { IconTextCaption } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";

import type { WordCount, WordCounts } from "#/lib/editor/latex/word-count";

const format = new Intl.NumberFormat();
const total = (counts: WordCounts) =>
  counts.text + counts.headers + counts.captions;
const detail = (counts: WordCounts) =>
  `${format.format(counts.text)} text, ${format.format(counts.headers)} headings, ${format.format(counts.captions)} captions and footnotes`;

export function WordCountStatus({
  words,
  onReveal,
}: {
  words: WordCount;
  onReveal: (path: string, line: number) => void;
}) {
  const topLevel = Math.min(
    ...words.sections
      .map((section) => section.level)
      .filter((level) => level >= 0),
  );
  const label = `${format.format(words.total)} ${words.total === 1 ? "word" : "words"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="xs" />}
        aria-label={`Word count: ${label}`}
        title={detail(words)}
      >
        <IconTextCaption />
        <span className="tabular-nums max-sm:hidden">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        className="w-auto max-w-80 min-w-64"
        aria-label="Word count breakdown"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {label}
            <span className="block font-normal">{detail(words)}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {words.sections.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sections</DropdownMenuLabel>
              {words.sections.map((section, index) => (
                <DropdownMenuItem
                  key={`${section.path}:${section.line}:${index}`}
                  title={detail(section)}
                  onClick={() => onReveal(section.path, section.line)}
                >
                  <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                      paddingLeft: `${Math.max(section.level - topLevel, 0) * 0.75}rem`,
                    }}
                  >
                    {section.title}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {format.format(total(section))}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {words.files.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Files</DropdownMenuLabel>
              {words.files.map((file) => (
                <DropdownMenuItem
                  key={file.path}
                  title={detail(file)}
                  onClick={() => onReveal(file.path, 1)}
                >
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {format.format(total(file))}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { IconX } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import { useId, useMemo, useRef, useState } from "react";

import {
  latexPreamble,
  type LatexSymbol,
  searchLatexSymbols,
} from "#/lib/editor/latex/symbols";

export type SymbolPreamble = {
  source: string;
  filename: string;
  addPackage: (packageName: string) => void;
};

export function SymbolPalette({
  preamble,
  onInsert,
  onClose,
}: {
  preamble: SymbolPreamble;
  onInsert: (symbol: LatexSymbol) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const symbols = searchLatexSymbols(query);
  const { packages } = useMemo(
    () => latexPreamble(preamble.source),
    [preamble.source],
  );

  return (
    <section
      aria-label="LaTeX symbols"
      className="flex max-h-[50%] min-h-48 shrink-0 flex-col border-b"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 px-2 pt-1">
        <label htmlFor={id} className="text-xs font-medium">
          Symbols
        </label>
        <Input
          id={id}
          ref={input}
          autoFocus
          value={query}
          placeholder="Search name, command or category…"
          aria-label="Search LaTeX symbols"
          onChange={(event) => {
            setQuery(event.target.value);
            setAnnouncement("");
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              symbols[0]
            ) {
              event.preventDefault();
              onInsert(symbols[0]);
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close symbols"
          onClick={onClose}
        >
          <IconX />
        </Button>
      </div>
      <p className="text-muted-foreground px-2 py-1 text-xs">
        Math commands insert at your cursor. Packages are added only when you
        click Add.
      </p>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {symbols.length ? (
          <ul className="divide-y">
            {symbols.map((symbol) => (
              <li
                key={symbol.command}
                className="flex flex-wrap items-center gap-x-2"
              >
                <Button
                  variant="ghost"
                  className="h-auto min-h-8 min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left"
                  aria-label={`Insert ${symbol.command} (${symbol.name})`}
                  onClick={() => onInsert(symbol)}
                >
                  <span
                    aria-hidden="true"
                    className="w-8 shrink-0 text-center font-serif text-2xl font-normal"
                  >
                    {symbol.glyph}
                  </span>
                  <span className="min-w-0 whitespace-normal">
                    <span className="block text-xs">{symbol.name}</span>
                    <code className="text-muted-foreground text-xs font-normal break-all">
                      {symbol.command}
                    </code>
                  </span>
                </Button>
                <div className="flex flex-wrap items-center gap-1 px-2 py-1 text-xs">
                  {symbol.package ? (
                    packages.has(symbol.package) ? (
                      <span className="text-muted-foreground">
                        {symbol.package} · Loaded
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto min-h-8 text-xs break-all whitespace-normal"
                        title={`Add to ${preamble.filename}`}
                        onClick={() => {
                          const packageName = symbol.package;
                          if (!packageName) return;
                          preamble.addPackage(packageName);
                          setAnnouncement(
                            `Added \\usepackage{${packageName}} to ${preamble.filename}.`,
                          );
                          input.current?.focus();
                        }}
                      >
                        Add <code>{`\\usepackage{${symbol.package}}`}</code>
                      </Button>
                    )
                  ) : (
                    <span className="text-muted-foreground">
                      No package required
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No symbols found. Try “alpha”, “arrow” or “relations”.
          </p>
        )}
      </div>
      <p
        role="status"
        className="text-muted-foreground shrink-0 px-2 py-1 text-xs"
      >
        {announcement ||
          `${symbols.length} ${symbols.length === 1 ? "symbol" : "symbols"}`}
      </p>
    </section>
  );
}

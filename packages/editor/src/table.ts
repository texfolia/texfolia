import { EditorSelection, type StateCommand } from "@codemirror/state";

export type TableAlign = "l" | "c" | "r";
export type TableRuleStyle = "booktabs" | "hline";

export type TableInput = {
  html?: string | null;
  text?: string | null;
};

export type TableOptions = {
  /** Horizontal rule style. Defaults to `"booktabs"`. */
  rules?: TableRuleStyle;
  /** Indentation inside `\begin{tabular}...\end{tabular}`. Defaults to `"  "`. */
  indent?: string;
  /** Wrap the `tabular` in a `table` float. Defaults to `false`. */
  float?: boolean;
};

export type TableResult = {
  latex: string;
  /** LaTeX packages required by the emitted snippet (e.g. `"booktabs"`, `"multirow"`). */
  packages: string[];
  rows: number;
  columns: number;
};

type ParsedCell = {
  text: string;
  bold: boolean;
  align?: TableAlign;
  colspan: number;
  rowspan: number;
};

type ParsedTable = {
  rows: Array<{ inThead: boolean; cells: ParsedCell[] }>;
  colAligns: Array<TableAlign | undefined>;
  fromHtml: boolean;
};

type GridSlot =
  | {
      kind: "origin";
      cell: ParsedCell;
    }
  | {
      kind: "covered";
      originCol: number;
      colspan: number;
      align?: TableAlign;
    };

const LATEX_SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
};

const NUMERIC_CELL =
  /^(?:\([+$€£¥-]?\d[\d,]*(?:\.\d+)?%?\)|[+$€£¥−-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?%?)$/;

/**
 * Escapes LaTeX special characters and normalizes internal line breaks so a
 * spreadsheet cell value compiles safely inside a `tabular`.
 */
export function escapeLatexCell(text: string): string {
  const normalized = text
    .replaceAll("\u00a0", " ")
    .replace(/\s*(?:\r\n|\r|\n)\s*/g, " ")
    .trim();
  return normalized.replace(/[\\{}&%$#_~^]/g, (ch) => LATEX_SPECIALS[ch] ?? ch);
}

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function parseAlignValue(value: string | undefined): TableAlign | undefined {
  if (!value) return undefined;
  switch (value.trim().toLowerCase()) {
    case "left":
    case "start":
      return "l";
    case "center":
    case "middle":
      return "c";
    case "right":
    case "end":
      return "r";
    default:
      return undefined;
  }
}

function parseBoldValue(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "bold" || normalized === "bolder") return true;
  if (normalized === "normal" || normalized === "lighter") return false;
  const weight = Number.parseInt(normalized, 10);
  if (Number.isFinite(weight)) return weight >= 600;
  return undefined;
}

function parseCssDeclarations(declarations: string): {
  align?: TableAlign;
  bold?: boolean;
} {
  let align: TableAlign | undefined;
  let bold: boolean | undefined;
  for (const part of declarations.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const val = part
      .slice(colon + 1)
      .replace(/!important\s*$/i, "")
      .trim();
    if (prop === "text-align") align = parseAlignValue(val) ?? align;
    else if (prop === "font-weight") {
      const parsed = parseBoldValue(val);
      if (parsed !== undefined) bold = parsed;
    }
  }
  return { align, bold };
}

function extractStyleClasses(
  html: string,
): Map<string, { align?: TableAlign; bold?: boolean }> {
  const classes = new Map<string, { align?: TableAlign; bold?: boolean }>();
  for (const styleMatch of html.matchAll(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
  )) {
    const css = styleMatch[1] ?? "";
    for (const rule of css.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g)) {
      const name = rule[1];
      const body = rule[2];
      if (!name || !body) continue;
      const parsed = parseCssDeclarations(body);
      if (parsed.align !== undefined || parsed.bold !== undefined) {
        const prev = classes.get(name);
        classes.set(name, {
          align: parsed.align ?? prev?.align,
          bold: parsed.bold ?? prev?.bold,
        });
      }
    }
  }
  return classes;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(
    /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeHtmlEntities(value);
  }
  return attrs;
}

function parseSpanAttr(value: string | undefined, max: number): number {
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, max);
}

function extractCellText(innerHtml: string): string {
  const stripped = innerHtml
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeHtmlEntities(stripped);
}

function innerHtmlIsBold(innerHtml: string): boolean {
  const trimmed = innerHtml.trim();
  if (!trimmed) return false;
  if (/^<(b|strong)\b[^>]*>[\s\S]*<\/\1>$/i.test(trimmed)) return true;
  const spanMatch = trimmed.match(/^<span\b([^>]*)>[\s\S]*<\/span>$/i);
  if (spanMatch) {
    const attrs = parseAttributes(spanMatch[1] ?? "");
    if (attrs.style && parseCssDeclarations(attrs.style).bold) return true;
  }
  return false;
}

function parseHtmlTable(html: string): ParsedTable | null {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const classes = extractStyleClasses(withoutComments);
  const tableMatch = withoutComments.match(
    /<table\b[^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!tableMatch) return null;
  const tableInner = tableMatch[1] ?? "";

  const colAligns: Array<TableAlign | undefined> = [];
  const rows: Array<{ inThead: boolean; cells: ParsedCell[] }> = [];

  let inThead = false;
  let currentRow: { inThead: boolean; cells: ParsedCell[] } | null = null;

  const tagPattern = /<(\/?)(thead|tbody|tfoot|tr|th|td|col)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(tableInner)) !== null) {
    const isClose = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const rawAttrs = match[3] ?? "";

    if (tag === "thead") {
      inThead = !isClose;
      continue;
    }
    if (tag === "tbody" || tag === "tfoot") {
      if (!isClose) inThead = false;
      continue;
    }
    if (tag === "col" && !isClose) {
      const attrs = parseAttributes(rawAttrs);
      const span = parseSpanAttr(attrs.span, 100);
      const style = attrs.style ? parseCssDeclarations(attrs.style) : {};
      const align = style.align ?? parseAlignValue(attrs.align);
      for (let i = 0; i < span; i++) colAligns.push(align);
      continue;
    }
    if (tag === "tr") {
      if (!isClose) {
        if (currentRow && currentRow.cells.length > 0) rows.push(currentRow);
        currentRow = { inThead, cells: [] };
      } else if (currentRow) {
        if (currentRow.cells.length > 0) rows.push(currentRow);
        currentRow = null;
      }
      continue;
    }
    if ((tag === "td" || tag === "th") && !isClose) {
      if (!currentRow) currentRow = { inThead, cells: [] };
      const contentStart = tagPattern.lastIndex;
      // Scan ahead for matching close tag or next cell/row boundary.
      const endPattern = /<(\/?)(td|th|tr|thead|tbody|tfoot)\b[^>]*>/gi;
      endPattern.lastIndex = contentStart;
      let contentEnd = tableInner.length;
      let nextIndex = tableInner.length;
      const endMatch = endPattern.exec(tableInner);
      if (endMatch) {
        contentEnd = endMatch.index;
        const endIsClose = endMatch[1] === "/";
        const endTag = (endMatch[2] ?? "").toLowerCase();
        nextIndex =
          endIsClose && endTag === tag
            ? endMatch.index + endMatch[0].length
            : endMatch.index;
      }
      tagPattern.lastIndex = nextIndex;

      const innerHtml = tableInner.slice(contentStart, contentEnd);
      const attrs = parseAttributes(rawAttrs);
      const inlineStyle = attrs.style ? parseCssDeclarations(attrs.style) : {};

      let classAlign: TableAlign | undefined;
      let classBold: boolean | undefined;
      if (attrs.class) {
        for (const cls of attrs.class.split(/\s+/)) {
          const style = classes.get(cls);
          if (!style) continue;
          if (style.align !== undefined) classAlign = style.align;
          if (style.bold !== undefined) classBold = style.bold;
        }
      }

      const align =
        inlineStyle.align ?? parseAlignValue(attrs.align) ?? classAlign;
      const explicitBold = inlineStyle.bold ?? classBold;
      const bold =
        explicitBold !== undefined
          ? explicitBold
          : tag === "th" || innerHtmlIsBold(innerHtml);

      currentRow.cells.push({
        text: extractCellText(innerHtml),
        bold,
        align,
        colspan: parseSpanAttr(attrs.colspan, 100),
        rowspan: parseSpanAttr(attrs.rowspan, 1000),
      });
    }
  }

  if (currentRow && currentRow.cells.length > 0) rows.push(currentRow);
  if (rows.length === 0) return null;
  return { rows, colAligns, fromHtml: true };
}

function parseTsv(text: string): ParsedTable | null {
  if (!text.includes("\t")) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === "\t") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines (spreadsheets commonly append a trailing newline).
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.every((cell) => cell.trim() === "")
  ) {
    rows.pop();
  }

  if (rows.length < 2) return null;
  const maxCols = Math.max(...rows.map((r) => r.length));
  if (maxCols < 2) return null;

  // Reject single-column text that merely happens to be tab-indented (e.g. "\tfoo\n\tbar").
  const nonEmptyCols = new Set<number>();
  for (const r of rows) {
    for (let c = 0; c < r.length; c++) {
      if (r[c]!.trim() !== "") nonEmptyCols.add(c);
    }
  }
  const allLeadingEmpty = rows.every((r) => (r[0] ?? "").trim() === "");
  if (allLeadingEmpty && nonEmptyCols.size <= 1) return null;

  return {
    rows: rows.map((cells) => ({
      inThead: false,
      cells: cells.map((cell) => ({
        text: cell,
        bold: false,
        colspan: 1,
        rowspan: 1,
      })),
    })),
    colAligns: [],
    fromHtml: false,
  };
}

function buildGrid(parsed: ParsedTable): {
  grid: Array<Array<GridSlot | undefined>>;
  numCols: number;
} {
  const numRows = parsed.rows.length;
  const grid: Array<Array<GridSlot | undefined>> = Array.from(
    { length: numRows },
    () => [],
  );
  let numCols = 0;

  for (let r = 0; r < numRows; r++) {
    const row = parsed.rows[r]!;
    let c = 0;
    for (const cell of row.cells) {
      while (grid[r]![c] !== undefined) c++;
      const rowspan = Math.min(cell.rowspan, numRows - r);
      const clampedCell: ParsedCell =
        rowspan === cell.rowspan ? cell : { ...cell, rowspan };

      grid[r]![c] = { kind: "origin", cell: clampedCell };
      for (let dc = 1; dc < clampedCell.colspan; dc++) {
        grid[r]![c + dc] = {
          kind: "covered",
          originCol: c,
          colspan: clampedCell.colspan,
          align: clampedCell.align,
        };
      }
      for (let dr = 1; dr < rowspan; dr++) {
        for (let dc = 0; dc < clampedCell.colspan; dc++) {
          grid[r + dr]![c + dc] = {
            kind: "covered",
            originCol: c,
            colspan: clampedCell.colspan,
            align: clampedCell.align,
          };
        }
      }
      c += clampedCell.colspan;
      if (c > numCols) numCols = c;
    }
  }

  return { grid, numCols };
}

function isNumericCell(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && NUMERIC_CELL.test(trimmed);
}

function detectHeaderRowCount(
  parsed: ParsedTable,
  grid: Array<Array<GridSlot | undefined>>,
): { headerRows: number; midruleAfter: number | null } {
  if (parsed.rows.length < 2) return { headerRows: 0, midruleAfter: null };

  const canBreakAfter = (rowIndex: number) => {
    if (rowIndex < 0 || rowIndex >= grid.length - 1) return false;
    // Do not place a rule across a rowspan that continues into the next row.
    for (let r = 0; r <= rowIndex; r++) {
      for (const slot of grid[r] ?? []) {
        if (slot?.kind === "origin" && r + slot.cell.rowspan - 1 > rowIndex) {
          return false;
        }
      }
    }
    return true;
  };

  if (parsed.fromHtml) {
    let theadRows = 0;
    while (theadRows < parsed.rows.length && parsed.rows[theadRows]!.inThead) {
      theadRows++;
    }
    if (theadRows > 0 && theadRows < parsed.rows.length) {
      return {
        headerRows: theadRows,
        midruleAfter: canBreakAfter(theadRows - 1) ? theadRows - 1 : null,
      };
    }

    const firstRow = parsed.rows[0]!;
    const nonEmpty = firstRow.cells.filter((cell) => cell.text.trim() !== "");
    if (nonEmpty.length > 0 && nonEmpty.every((cell) => cell.bold)) {
      return {
        headerRows: 1,
        midruleAfter: canBreakAfter(0) ? 0 : null,
      };
    }
    return { headerRows: 0, midruleAfter: null };
  }

  // For bare TSV: treat row 0 as a header when it contains non-numeric labels.
  const firstNonEmpty = parsed.rows[0]!.cells.filter(
    (cell) => cell.text.trim() !== "",
  );
  if (
    firstNonEmpty.length > 0 &&
    !firstNonEmpty.every((cell) => isNumericCell(cell.text))
  ) {
    return { headerRows: 1, midruleAfter: 0 };
  }
  return { headerRows: 0, midruleAfter: null };
}

function inferColumnAlignments(
  grid: Array<Array<GridSlot | undefined>>,
  numCols: number,
  colHints: Array<TableAlign | undefined>,
  headerRows: number,
): TableAlign[] {
  const dataStart = headerRows < grid.length ? headerRows : 0;
  const aligns: TableAlign[] = [];

  for (let c = 0; c < numCols; c++) {
    const counts: Record<TableAlign, number> = { l: 0, c: 0, r: 0 };
    for (let r = dataStart; r < grid.length; r++) {
      const slot = grid[r]?.[c];
      if (
        slot?.kind === "origin" &&
        slot.cell.colspan === 1 &&
        slot.cell.align
      ) {
        counts[slot.cell.align]++;
      }
    }

    const totalExplicit = counts.l + counts.c + counts.r;
    if (totalExplicit > 0) {
      if (counts.r >= counts.c && counts.r >= counts.l) aligns.push("r");
      else if (counts.c >= counts.l) aligns.push("c");
      else aligns.push("l");
      continue;
    }

    if (colHints[c]) {
      aligns.push(colHints[c]!);
      continue;
    }

    // Check row 0 explicit alignment if data rows had none.
    const headerSlot = grid[0]?.[c];
    if (
      headerSlot?.kind === "origin" &&
      headerSlot.cell.colspan === 1 &&
      headerSlot.cell.align
    ) {
      aligns.push(headerSlot.cell.align);
      continue;
    }

    // Otherwise right-align columns whose non-empty data cells are all numeric.
    let nonEmptyCount = 0;
    let numericCount = 0;
    for (let r = dataStart; r < grid.length; r++) {
      const slot = grid[r]?.[c];
      if (slot?.kind === "origin" && slot.cell.colspan === 1) {
        const trimmed = slot.cell.text.trim();
        if (trimmed) {
          nonEmptyCount++;
          if (isNumericCell(trimmed)) numericCount++;
        }
      }
    }
    aligns.push(
      nonEmptyCount > 0 && numericCount === nonEmptyCount ? "r" : "l",
    );
  }

  return aligns;
}

/**
 * Converts clipboard HTML (preferred when containing a `<table>`) or TSV text
 * from Excel / Google Sheets into a LaTeX `tabular` snippet.
 *
 * Returns `null` if the input does not represent a multi-row, multi-column table.
 */
export function tableToLatex(
  input: TableInput,
  options: TableOptions = {},
): TableResult | null {
  const { rules = "booktabs", indent = "  ", float = false } = options;

  const parsed =
    (input.html ? parseHtmlTable(input.html) : null) ??
    (input.text ? parseTsv(input.text) : null);
  if (!parsed) return null;

  const { grid, numCols } = buildGrid(parsed);
  if (grid.length < 2 || numCols < 2) return null;

  const { headerRows, midruleAfter } = detectHeaderRowCount(parsed, grid);
  const colAligns = inferColumnAlignments(
    grid,
    numCols,
    parsed.colAligns,
    headerRows,
  );

  let usesMultirow = false;
  const emittedRows: string[] = [];

  for (let r = 0; r < grid.length; r++) {
    const parts: string[] = [];
    let c = 0;
    while (c < numCols) {
      const slot = grid[r]?.[c];
      if (!slot) {
        parts.push("");
        c++;
        continue;
      }
      if (slot.kind === "covered") {
        if (slot.originCol === c) {
          if (slot.colspan > 1) {
            const align = slot.align ?? colAligns[c] ?? "l";
            parts.push(`\\multicolumn{${slot.colspan}}{${align}}{}`);
            c += slot.colspan;
          } else {
            parts.push("");
            c++;
          }
        } else {
          c++;
        }
        continue;
      }

      const { cell } = slot;
      const escaped = escapeLatexCell(cell.text);
      const content = cell.bold && escaped ? `\\textbf{${escaped}}` : escaped;
      const cellAlign = cell.align ?? colAligns[c] ?? "l";

      if (cell.rowspan > 1) usesMultirow = true;

      if (cell.colspan > 1 && cell.rowspan > 1) {
        parts.push(
          `\\multicolumn{${cell.colspan}}{${cellAlign}}{\\multirow{${cell.rowspan}}{*}{${content}}}`,
        );
      } else if (cell.colspan > 1) {
        parts.push(`\\multicolumn{${cell.colspan}}{${cellAlign}}{${content}}`);
      } else if (cell.rowspan > 1) {
        parts.push(`\\multirow{${cell.rowspan}}{*}{${content}}`);
      } else {
        parts.push(content);
      }
      c += cell.colspan;
    }
    emittedRows.push(`${parts.join(" & ")} \\\\`);
  }

  const topRule = rules === "booktabs" ? "\\toprule" : "\\hline";
  const midRule = rules === "booktabs" ? "\\midrule" : "\\hline";
  const bottomRule = rules === "booktabs" ? "\\bottomrule" : "\\hline";

  const bodyLines: string[] = [
    `\\begin{tabular}{${colAligns.join("")}}`,
    `${indent}${topRule}`,
  ];
  for (let r = 0; r < emittedRows.length; r++) {
    bodyLines.push(`${indent}${emittedRows[r]}`);
    if (midruleAfter === r) bodyLines.push(`${indent}${midRule}`);
  }
  bodyLines.push(`${indent}${bottomRule}`, "\\end{tabular}");

  const packages: string[] = [];
  if (rules === "booktabs") packages.push("booktabs");
  if (usesMultirow) packages.push("multirow");

  const latex = float
    ? [
        "\\begin{table}[htbp]",
        `${indent}\\centering`,
        ...bodyLines.map((line) => `${indent}${line}`),
        `${indent}\\caption{}`,
        `${indent}\\label{tab:}`,
        "\\end{table}",
      ].join("\n")
    : bodyLines.join("\n");

  return {
    latex,
    packages,
    rows: grid.length,
    columns: numCols,
  };
}

/**
 * Inserts a converted LaTeX table at the current selection in a single
 * transaction so one undo step restores the previous document state.
 */
export function insertLatexTable(latex: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(
      state.update(
        state.changeByRange((range) => {
          const line = state.doc.lineAt(range.from);
          const prefix = line.text.slice(0, range.from - line.from);
          const lineIndent = /^\s*$/.test(prefix) ? prefix : "";
          const insert = lineIndent
            ? latex.replaceAll("\n", `\n${lineIndent}`)
            : latex;
          return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.cursor(range.from + insert.length),
          };
        }),
        { userEvent: "input.paste", scrollIntoView: true },
      ),
    );
    return true;
  };
}

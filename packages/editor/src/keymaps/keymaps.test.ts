import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { emacsKeys } from "@replit/codemirror-emacs";

import { keymapChords } from "./keymaps";

const keyNames: Record<string, string> = {
  BS: "Backspace",
  Esc: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};
// Converts a package chord such as `S-C-f` or `C-BS` to `Ctrl+Shift+F`.
function chord(modifiers: string[], key: string) {
  const name = keyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [
    modifiers.includes("C") && "Ctrl",
    modifiers.includes("M") && "Alt",
    modifiers.includes("A") && "Alt",
    modifiers.includes("S") && "Shift",
    name,
  ]
    .filter(Boolean)
    .join("+");
}
const modified = (chords: Iterable<string>) =>
  [...new Set(chords)].filter((value) => /^(?:Ctrl|Alt)\+/.test(value)).sort();

describe("keymap chords", () => {
  test("cover every Emacs binding's first chord", () => {
    const chords = Object.keys(emacsKeys).flatMap((group) =>
      group.split("|").map((binding) => {
        const parts = (binding.split(/\s+/)[0] ?? "").split(/-(?=.)/);
        const key = parts.pop() ?? "";
        return chord(parts, key);
      }),
    );
    const digits = Array.from({ length: 10 }, (_, digit) => `Ctrl+${digit}`);
    expect(modified(keymapChords.emacs)).toEqual(
      modified([...chords, ...digits]),
    );
  });

  test("cover every Vim key binding", () => {
    // The default keymap is internal to vim-core, so read it from the source.
    const vimPackage = dirname(
      Bun.resolveSync("@replit/codemirror-vim/package.json", import.meta.dir),
    );
    const source = readFileSync(
      Bun.resolveSync("@replit/codemirror-vim-core", join(vimPackage, "dist")),
      "utf8",
    );
    const chords = [
      ...source.matchAll(/keys: '<([CA](?:-[CAS])*)-([^>]+)>/g),
    ].map(([, prefix = "", key = ""]) => chord(prefix.split("-"), key));
    expect(chords.length).toBeGreaterThan(10);
    expect(modified(keymapChords.vim)).toEqual(modified(chords));
  });
});

import {
  dracula,
  githubDark,
  githubLight,
  nord,
  solarizedLight,
  vscodeDark,
  xcodeLight,
} from "@uiw/codemirror-themes-all";
import { z } from "zod";

export const editorThemes = {
  githubLight: { label: "GitHub Light", extension: githubLight },
  githubDark: { label: "GitHub Dark", extension: githubDark },
  vscodeDark: { label: "VS Code Dark", extension: vscodeDark },
  dracula: { label: "Dracula", extension: dracula },
  nord: { label: "Nord", extension: nord },
  solarizedLight: { label: "Solarized Light", extension: solarizedLight },
  xcodeLight: { label: "Xcode Light", extension: xcodeLight },
};

export const editorThemeSchema = z.custom<keyof typeof editorThemes>(
  (value): value is keyof typeof editorThemes =>
    typeof value === "string" && Object.hasOwn(editorThemes, value),
);

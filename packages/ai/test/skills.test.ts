import { describe, expect, test } from "bun:test";

import { isAgentsFile, parseSkill, skillFolderName } from "../src/skills";

const path = ".agents/skills/bibtex-style/SKILL.md";

describe("skill paths", () => {
  test("recognizes skill entry points and AGENTS.md files", () => {
    expect(skillFolderName(path)).toBe("bibtex-style");
    expect(skillFolderName(".agents/skills/x/notes.md")).toBeNull();
    expect(skillFolderName(".agents/skills/SKILL.md")).toBeNull();
    expect(skillFolderName("chapters/.agents/skills/x/SKILL.md")).toBeNull();
    expect(isAgentsFile("AGENTS.md")).toBe(true);
    expect(isAgentsFile("chapters/AGENTS.md")).toBe(true);
    expect(isAgentsFile("NOT_AGENTS.md")).toBe(false);
  });
});

describe("parseSkill", () => {
  test("reads a valid skill, including folded descriptions", () => {
    const source =
      "---\nname: bibtex-style\ndescription: >\n  Format BibTeX entries\n  the lab's way.\nlicense: CC0-1.0\n---\n\n# Steps\n";
    expect(parseSkill(path, source)).toEqual({
      name: "bibtex-style",
      description: "Format BibTeX entries the lab's way.",
      path,
    });
  });

  test("accepts CRLF line endings and a byte order mark", () => {
    const source =
      String.fromCharCode(0xfeff) +
      "---\r\nname: bibtex-style\r\ndescription: Cite things.\r\n---\r\nBody";
    expect(parseSkill(path, source).problems).toBeUndefined();
  });

  test("reports problems instead of throwing", () => {
    expect(parseSkill(path, "# No frontmatter").problems).toEqual([
      "Missing YAML frontmatter.",
      "Missing name.",
      "Missing description.",
    ]);
    expect(parseSkill(path, "---\nname: [\n---\n").problems).toContain(
      "Frontmatter is not valid YAML.",
    );
    expect(parseSkill(path, "---\n- a\n---\n").problems).toContain(
      "Frontmatter must be a YAML mapping.",
    );
    const wrong = parseSkill(
      path,
      "---\nname: Bibtex--Style\ndescription: x\n---\n",
    );
    expect(wrong.name).toBe("Bibtex--Style");
    expect(wrong.problems).toEqual([
      "name must be 1–64 lowercase letters, digits, and single hyphens.",
      "name must match its folder name (bibtex-style).",
    ]);
  });

  test("falls back to the folder name and caps long descriptions", () => {
    const skill = parseSkill(
      path,
      `---\ndescription: ${"d".repeat(2000)}\n---\n`,
    );
    expect(skill.name).toBe("bibtex-style");
    expect(skill.description).toHaveLength(1025);
    expect(skill.problems).toEqual([
      "Missing name.",
      "description must be at most 1024 characters.",
    ]);
  });
});

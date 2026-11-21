import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);
const errors = [];

for (const file of files) {
  if (
    !file.endsWith(".md") ||
    file.startsWith(".agents/") ||
    !existsSync(resolve(root, file))
  )
    continue;
  const markdown = readFileSync(resolve(root, file), "utf8").replace(
    /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
    "",
  );
  for (const match of markdown.matchAll(
    /\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g,
  )) {
    const target = match[1].split(/[?#]/)[0];
    if (!target || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue;
    const path = target.startsWith("/")
      ? resolve(root, `.${target}`)
      : resolve(root, dirname(file), decodeURIComponent(target));
    if (!existsSync(path))
      errors.push(`${file}: broken local link ${match[1]}`);
  }
}

for (const file of files.filter(
  (file) => file.startsWith("apps/app/src/") && file.endsWith(".css"),
)) {
  if (file !== "apps/app/src/styles.css") {
    errors.push(
      `${file}: put styles in Tailwind classes, theme tokens, or @utility in styles.css`,
    );
    continue;
  }
  const css = postcss.parse(readFileSync(resolve(root, file), "utf8"), {
    from: file,
  });
  for (const node of css.nodes) {
    if (node.type === "comment") continue;
    if (
      node.type === "atrule" &&
      [
        "import",
        "source",
        "custom-variant",
        "theme",
        "utility",
        "font-face",
      ].includes(node.name)
    )
      continue;
    if (
      node.type === "rule" &&
      [":root", ".dark"].includes(node.selector) &&
      node.nodes.every(
        (child) =>
          child.type === "comment" ||
          (child.type === "decl" && child.prop.startsWith("--")),
      )
    )
      continue;
    errors.push(
      `${relative(root, node.source.input.file)}:${node.source.start.line}: use Tailwind classes; styles.css allows only imports, theme tokens, font setup, and @utility`,
    );
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Local Markdown links and Tailwind-only styles passed.");
}

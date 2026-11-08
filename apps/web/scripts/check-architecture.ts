import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";

const root = resolve(import.meta.dirname, "../src");
const violations: string[] = [];

function check(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      check(path);
      continue;
    }
    if (!/\.tsx?$/.test(path) || path.endsWith(".d.ts")) continue;
    const owner = relative(root, path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      const target = specifier.startsWith("#/")
        ? specifier.slice(2)
        : specifier.startsWith(".")
          ? relative(root, resolve(dirname(path), specifier))
          : specifier;
      const report = (rule: string) =>
        violations.push(`${owner}: ${rule} (${specifier})`);
      if (
        (/^(components|hooks)\//.test(owner) ||
          (owner.startsWith("features/") && owner.endsWith(".tsx"))) &&
        /^features\/.*\/server$/.test(target)
      )
        report(
          "Use a feature collection action; server functions belong to loaders and collection adapters",
        );
      if (
        /^features\/.*\/(collections|collection|schema)\.ts$/.test(owner) &&
        /^(components|hooks|routes)\//.test(target)
      )
        report(
          "Keep data ownership independent of React components and route composition",
        );
      if (
        owner.startsWith("data/") &&
        /^(features|components|hooks|routes)\//.test(target)
      )
        report("Keep collection adapters independent of feature policy");
      if (
        owner.startsWith("features/") &&
        !owner.endsWith("server.ts") &&
        !statement.importClause?.isTypeOnly &&
        target === "@texfolia/db"
      )
        report("Keep database connections inside server modules");
    }
  }
}

check(root);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Architecture boundaries passed.");
}

import assert from "node:assert/strict";

import { compileOnEngine, compileSuccessfully } from "./engine-client";

// Compiles biblatex documents on a running engine, then tries to run code through
// biber. What a command leaves in biber's directory becomes an artifact, and what
// it prints is logged when biber then fails.
const preamble = (
  options = "",
  sources = String.raw`\addbibresource{refs.bib}`,
) =>
  String.raw`\documentclass{article}
\usepackage[backend=biber${options}]{biblatex}
${sources}`;
const body = String.raw`
\begin{document}
\cite{knuth}
\printbibliography
\end{document}`;
const bibliography =
  "@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}\n";
const quiet = "`id>executed`";
const loud = "system(q(id))";
const traces = "uid=";

const compile = (tex: string, files: Record<string, string> = {}) =>
  compileOnEngine({
    affinity: crypto.randomUUID(),
    files: { "main.tex": tex, "refs.bib": bibliography, ...files },
  });

for (const style of ["numeric", "authoryear", "alphabetic", "ieee", "apa"]) {
  const output = await compileSuccessfully({
    affinity: crypto.randomUUID(),
    files: {
      "main.tex": preamble(`,style=${style}`) + body,
      "refs.bib": bibliography,
    },
  });
  assert.match(output.result.log, /Running external tool biber/, style);
  assert.doesNotMatch(output.result.log, /downloading/, `${style} is baked in`);
  assert(output.files.get("main.bbl")?.length, style);
}
// Biber sees an edited or deleted source, not a copy in the build cache.
const affinity = crypto.randomUUID();
const tex = preamble() + body;
const first = await compileSuccessfully({
  affinity,
  files: { "main.tex": tex, "refs.bib": bibliography },
});
assert(!first.files.has("refs.bib"));
const edited = await compileSuccessfully({
  affinity,
  files: { "main.tex": tex, "refs.bib": bibliography.replace("TeX", "Edited") },
  cache: first.cache,
});
assert.match(
  new TextDecoder().decode(edited.files.get("main.bbl")),
  /The Editedbook/,
);
const deleted = await compileOnEngine({
  affinity,
  files: { "main.tex": tex },
  cache: edited.cache,
});
assert.equal(deleted.status, 422, "A deleted bibliography was found");

const mapped = await compile(
  preamble() +
    String.raw`\DeclareSourcemap{\maps{\map{\step[fieldsource=title,match=\regexp{(The)\s+(\w+)},replace=\regexp{\U$2\E, $1}]}}}` +
    body,
);
assert.match(
  new TextDecoder().decode(mapped.files.get("main.bbl")),
  /TEXBOOK, ?The/,
);

// Tectonic runs what main.run.xml asks for, whoever wrote it.
const control = new TextDecoder().decode(
  (await compile(preamble() + body)).files.get("main.bcf"),
);
const request = (argument: string, input: string) =>
  String.raw`\begin{filecontents*}[overwrite]{main.run.xml}
<requests><external><generic>biber</generic><cmdline><binary>biber</binary>${argument}<infile>main</infile></cmdline><input><file>main.bcf</file>${input}</input><requires><file>refs.bib</file></requires></external></requests>
\end{filecontents*}
\documentclass{article}\begin{document}Forged\end{document}`;

const attacks: Record<string, [string, Record<string, string>?]> = {
  "source map replacement": [
    preamble() +
      String.raw`\DeclareSourcemap{\maps{\map{\step[fieldsource=title,match=\regexp{.+},replace=\regexp{@{[${quiet}]}}]}}}` +
      body,
  ],
  "data source type": [
    preamble(
      "",
      String.raw`\addbibresource[datatype=bibtex;${loud}]{refs.bib}`,
    ) + body,
  ],
  "sort key": [
    preamble() + body.replace("{knuth}", "{knuth,other}"),
    {
      "refs.bib":
        bibliography +
        `@book{other, author={A}, title={T}, presort={x\\{}.${quiet}.q{\\}}, sortkey={x\\{}.${quiet}.q{\\}}}`,
    },
  ],
  "forged arguments": [
    request(`<option>--collate-options=level=&gt;${loud}</option>`, ""),
    { "main.bcf": control },
  ],
  "forged configuration": [
    request("", "<file>biber.conf</file>"),
    {
      "main.bcf": control,
      "biber.conf": `<?xml version="1.0"?><config><sourcemap><maps datatype="bibtex"><map><map_step map_field_source="title" map_match=".+" map_replace="@{[${quiet.replace(">", "&gt;")}]}"/></map></maps></sourcemap></config>`,
    },
  ],
};
for (const [name, [tex, files]] of Object.entries(attacks)) {
  const output = await compile(tex, files);
  assert.match(output.result.log, /Running external tool biber/, name);
  assert(
    !output.files.has("executed") && !output.result.log.includes(traces),
    `${name} ran a command`,
  );
}

// Biber reads only what the project contains.
for (const [source, message] of [
  ["/etc/passwd", "is not in the project"],
  ["https://example.com/refs.bib", "is not supported"],
] as const) {
  const output = await compile(
    preamble(
      "",
      String.raw`\addbibresource[location=${source.startsWith("/") ? "local" : "remote"}]{${source}}`,
    ) + body,
  );
  assert.equal(output.status, 422, source);
  assert(output.result.log.includes(message), output.result.log);
}
console.info(
  "Biber compiled every style and source maps, and ran no commands from a document.",
);

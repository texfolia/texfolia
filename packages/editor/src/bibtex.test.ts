import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bibEntryKeys,
  entryAppendix,
  parseReferenceId,
  setEntryKey,
  similarKeys,
  uniqueEntryKey,
  validEntryKey,
} from "./bibtex";

test("recognizes DOIs in their usual forms", () => {
  for (const input of [
    "10.1145/3368089.3409741",
    " doi:10.1145/3368089.3409741 ",
    "https://doi.org/10.1145/3368089.3409741",
    "http://dx.doi.org/10.1145/3368089.3409741",
  ])
    assert.deepEqual(parseReferenceId(input), {
      kind: "doi",
      id: "10.1145/3368089.3409741",
    });
  assert.deepEqual(
    parseReferenceId("https://doi.org/10.1002/%28SICI%291097-4636"),
    { kind: "doi", id: "10.1002/(SICI)1097-4636" },
  );
});

test("recognizes arXiv IDs, URLs and arXiv DOIs", () => {
  for (const [input, id] of [
    ["1706.03762", "1706.03762"],
    ["arXiv:1706.03762v5", "1706.03762v5"],
    ["https://arxiv.org/abs/2401.12345", "2401.12345"],
    ["https://arxiv.org/pdf/2401.12345v2.pdf", "2401.12345v2"],
    ["hep-th/9901001", "hep-th/9901001"],
    ["math.GT/0309136", "math.GT/0309136"],
    ["10.48550/arXiv.1706.03762", "1706.03762"],
  ] satisfies [string, string][])
    assert.deepEqual(parseReferenceId(input), { kind: "arxiv", id }, input);
});

test("recognizes ISBNs with valid check digits", () => {
  assert.deepEqual(parseReferenceId("978-0-201-52983-8"), {
    kind: "isbn",
    id: "9780201529838",
  });
  assert.deepEqual(parseReferenceId("ISBN 0-201-52983-1"), {
    kind: "isbn",
    id: "0201529831",
  });
  assert.deepEqual(parseReferenceId("080442957x"), {
    kind: "isbn",
    id: "080442957X",
  });
  assert.equal(parseReferenceId("978-0-201-52983-9"), null);
  assert.equal(parseReferenceId("not an id"), null);
  assert.equal(parseReferenceId(""), null);
});

test("finds entry keys and replaces the first", () => {
  const source =
    "@string{acm = {ACM}}\n@article{knuth1984,\n  title = {x}\n}\n@book( lamport , title={y})";
  assert.deepEqual(
    bibEntryKeys(source).map(({ key }) => key),
    ["knuth1984", "lamport"],
  );
  assert.equal(
    setEntryKey("@article{old,\n  title = {x}\n}\n", "new2020"),
    "@article{new2020,\n  title = {x}\n}\n",
  );
});

test("makes keys unique without regard to case", () => {
  assert.equal(uniqueEntryKey("knuth1984", []), "knuth1984");
  assert.equal(uniqueEntryKey("knuth1984", ["Knuth1984"]), "knuth1984a");
  assert.equal(uniqueEntryKey("k", ["k", "ka", "kb"]), "kc");
  const many = ["k", ..."abcdefghijklmnopqrstuvwxyz".split("")].map((s, i) =>
    i ? `k${s}` : s,
  );
  assert.equal(uniqueEntryKey("k", many), "kaa");
});

test("separates appended entries with a blank line", () => {
  const entry = "@misc{a,\n}\n";
  assert.equal(entryAppendix("", entry), entry);
  assert.equal(entryAppendix("@misc{b,\n}", entry), `\n\n${entry}`);
  assert.equal(entryAppendix("@misc{b,\n}\n", entry), `\n${entry}`);
  assert.equal(entryAppendix("@misc{b,\n}\n\n\n", entry), entry);
});

test("validates keys", () => {
  assert.ok(validEntryKey("knuth:1984-tex"));
  for (const key of ["", "a b", "a,b", "a{b", 'a"b', "a%b"])
    assert.ok(!validEntryKey(key), key);
});

test("suggests close keys for typos", () => {
  const keys = ["knuth1984", "knuth1986", "lamport1994", "Smith2020"];
  assert.deepEqual(similarKeys("knuht1984", keys), ["knuth1984", "knuth1986"]);
  assert.deepEqual(similarKeys("lampotr1994", keys), ["lamport1994"]);
  assert.deepEqual(similarKeys("knuth1985", keys), ["knuth1984", "knuth1986"]);
  assert.deepEqual(similarKeys("smith2020", keys), ["Smith2020"]);
  assert.deepEqual(similarKeys("unrelated", keys), []);
});

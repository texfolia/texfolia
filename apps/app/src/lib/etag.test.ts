import { expect, test } from "bun:test";

import { matchesEtag, weakEtag } from "./etag";

const request = (header?: string) =>
  new Request("https://app.test/", {
    headers: header === undefined ? {} : { "If-None-Match": header },
  });

test("If-None-Match compares weakly and accepts lists", () => {
  const etag = weakEtag("abc");
  for (const header of ['W/"abc"', '"abc"', '"x", W/"abc"', "*"])
    expect([header, matchesEtag(request(header), etag)]).toEqual([
      header,
      true,
    ]);
  for (const header of [undefined, "", '"x"', "abc", 'W/"abcd"'])
    expect([header, matchesEtag(request(header), etag)]).toEqual([
      header,
      false,
    ]);
});

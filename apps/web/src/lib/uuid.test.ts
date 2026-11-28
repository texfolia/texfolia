import { expect, test } from "bun:test";

import { z } from "zod";

import { isUuid } from "./uuid";

test("accepts the same IDs as z.uuid()", () => {
  const id = crypto.randomUUID();
  for (const value of [
    id,
    id.toUpperCase(),
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    "018f4a3c-1111-7abc-8def-0123456789ab",
    "018f4a3c-1111-9abc-8def-0123456789ab",
    "018f4a3c-1111-7abc-0def-0123456789ab",
    `${id} `,
    `${id}\n`,
    id.replaceAll("-", ""),
    "publish",
    "",
  ])
    expect([value, isUuid(value)]).toEqual([
      value,
      z.uuid().safeParse(value).success,
    ]);
});

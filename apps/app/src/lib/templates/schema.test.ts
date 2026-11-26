import { expect, test } from "bun:test";

import { openTemplateSchema, publishTemplateSchema } from "./index";

const valid = {
  projectId: crypto.randomUUID(),
  title: "An article",
  description: "An original article template",
  tags: ["Article", "article"],
  license: "CC0-1.0",
  visibility: "public",
  redistributionConfirmed: true,
};

test("publishing requires a known license and redistribution confirmation", () => {
  expect(publishTemplateSchema.parse(valid).tags).toEqual(["article"]);
  for (const license of [undefined, "", "all rights reserved"])
    expect(publishTemplateSchema.safeParse({ ...valid, license }).success).toBe(
      false,
    );
  expect(
    publishTemplateSchema.safeParse({
      ...valid,
      redistributionConfirmed: false,
    }).success,
  ).toBe(false);
  expect(
    publishTemplateSchema.safeParse({ ...valid, visibility: "secret" }).success,
  ).toBe(false);
});

test("private templates need no license or redistribution confirmation", () => {
  const { license: _, redistributionConfirmed: __, ...rest } = valid;
  const parsed = publishTemplateSchema.parse({
    ...rest,
    visibility: "private",
  });
  expect(parsed.visibility).toBe("private");
  expect("license" in parsed).toBe(false);
  // A license sent anyway is dropped, not stored.
  expect(
    "license" in
      publishTemplateSchema.parse({ ...valid, visibility: "private" }),
  ).toBe(false);
  for (const visibility of ["public", "unlisted"])
    expect(
      publishTemplateSchema.safeParse({ ...rest, visibility }).success,
    ).toBe(false);
});

test("publishing bounds metadata and opening validates the destination", () => {
  expect(
    publishTemplateSchema.safeParse({ ...valid, title: " ", description: " " })
      .success,
  ).toBe(false);
  expect(
    publishTemplateSchema.safeParse({
      ...valid,
      tags: Array(9).fill("article"),
    }).success,
  ).toBe(false);
  expect(
    openTemplateSchema.parse({
      templateId: crypto.randomUUID(),
      organizationId: null,
    }).organizationId,
  ).toBeNull();
  expect(
    openTemplateSchema.safeParse({
      templateId: "not-an-id",
      organizationId: null,
    }).success,
  ).toBe(false);
  expect(
    openTemplateSchema.safeParse({
      templateId: crypto.randomUUID(),
      organizationId: "",
    }).success,
  ).toBe(false);
});

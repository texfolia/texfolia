import { expect, test } from "bun:test";

import { openTemplateSchema, publishTemplateSchema } from "./template.schema";

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
    publishTemplateSchema.safeParse({ ...valid, visibility: "private" })
      .success,
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

import { expect, test } from "bun:test";

import { hasOrgRole, isOrgAdmin } from "./roles";

test("owners and admins are organization admins", () => {
  expect(isOrgAdmin("owner")).toBe(true);
  expect(isOrgAdmin("admin")).toBe(true);
  expect(isOrgAdmin("member")).toBe(false);
  expect(isOrgAdmin("")).toBe(false);
});

test("comma-separated roles match when any role does", () => {
  expect(isOrgAdmin("member,admin")).toBe(true);
  expect(isOrgAdmin("member, owner")).toBe(true);
  expect(isOrgAdmin("member,viewer")).toBe(false);
});

test("roles match exactly, not by substring", () => {
  expect(isOrgAdmin("administrator")).toBe(false);
  expect(isOrgAdmin("co-owner")).toBe(false);
  expect(hasOrgRole("member", "mem")).toBe(false);
});

test("hasOrgRole checks the given roles", () => {
  expect(hasOrgRole("member", "member")).toBe(true);
  expect(hasOrgRole("owner", "member")).toBe(false);
  expect(hasOrgRole("owner")).toBe(false);
});

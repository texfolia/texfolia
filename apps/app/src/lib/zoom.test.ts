import { expect, test } from "bun:test";

import { stepZoom, wheelZoom } from "./zoom";

const bounds = { min: 0.25, max: 3 };

test("steps stay in hundredths and inside the bounds", () => {
  expect(stepZoom(0.8333, 0.25, bounds)).toBe(1.08);
  expect(stepZoom(2.9, 0.25, bounds)).toBe(3);
  expect(stepZoom(0.3, -0.25, bounds)).toBe(0.25);
});

test("the wheel zooms in and out by the same factor, and only so much", () => {
  const closer = wheelZoom(1, { deltaY: -20, deltaMode: 0 }, bounds);
  expect(closer).toBeGreaterThan(1);
  expect(wheelZoom(closer, { deltaY: 20, deltaMode: 0 }, bounds)).toBeCloseTo(
    1,
  );
  expect(wheelZoom(1, { deltaY: -3, deltaMode: 1 }, bounds)).toBeCloseTo(
    wheelZoom(1, { deltaY: -48, deltaMode: 0 }, bounds),
  );
  expect(wheelZoom(1, { deltaY: -9999, deltaMode: 0 }, bounds)).toBeLessThan(
    1.5,
  );
  expect(wheelZoom(0.25, { deltaY: 100, deltaMode: 0 }, bounds)).toBe(0.25);
});

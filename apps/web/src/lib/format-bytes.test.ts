import { describe, expect, test } from "bun:test";

import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  test("formats zero and small byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes("0")).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("formats KiB, MiB, GiB, and TiB values cleanly", () => {
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(12_345_678)).toBe("11.8 MiB");
    expect(formatBytes("1073741824")).toBe("1 GiB");
    expect(formatBytes(2n * 1024n ** 4n)).toBe("2 TiB");
  });
});

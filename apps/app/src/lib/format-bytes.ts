const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Formats a non-negative byte count in human-readable binary units. */
export function formatBytes(value: bigint | number | string): string {
  const bytes =
    typeof value === "bigint"
      ? value
      : typeof value === "string"
        ? BigInt(value)
        : BigInt(Math.max(0, Math.trunc(value)));
  if (bytes <= 0n) return "0 B";
  if (bytes < 1024n) return `${bytes.toString()} B`;

  let unitIndex = 0;
  let scaled = Number(bytes);
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(decimals))} ${units[unitIndex]}`;
}

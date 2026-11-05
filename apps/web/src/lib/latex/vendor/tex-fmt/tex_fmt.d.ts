export default function init(options?: {
  module_or_path: string | BufferSource;
}): Promise<unknown>;
export function main(
  text: string,
  config: string,
): { output: string; logs: string };
export function version(): string;

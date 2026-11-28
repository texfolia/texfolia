import { useEffect, useState } from "react";

/**
 * Downloads a source file to preview it. Pass a `version` that changes with
 * the file; the last copy stays until the next one arrives.
 */
export function useSourceFile({
  url,
  name,
  type,
  version = "",
}: {
  url: string;
  name: string;
  type: string | undefined;
  version?: string;
}) {
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!type) return;
    const abort = new AbortController();
    setError("");
    void (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok)
          throw new Error("Could not open this file. Reopen it to try again.");
        const blob = await response.blob();
        if (!abort.signal.aborted) setFile(new File([blob], name, { type }));
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not open this file.",
          );
      }
    })();
    return () => abort.abort();
  }, [url, name, type, version]);
  return { file, error };
}

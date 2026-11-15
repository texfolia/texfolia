export function Sources({ urls }: { urls: string[] }) {
  const sources = [...new Set(urls)].filter((url) => /^https?:\/\//.test(url));
  if (!sources.length) return null;
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground cursor-pointer">
        Sources ({sources.length})
      </summary>
      <ul className="space-y-1 py-2">
        {sources.map((url) => (
          <li key={url}>
            <a
              className="break-all underline underline-offset-4"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

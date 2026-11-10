const url = "http://127.0.0.1:8787/health";
const deadline = Date.now() + 180_000;

while (true) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(1000),
  }).catch(() => null);
  if (response?.ok) break;
  if (Date.now() >= deadline)
    throw new Error("Compiler Worker did not become ready at " + url);
  await Bun.sleep(250);
}

// Run against either the Bun API or `wrangler dev`; no credentials or remote resources.
import { coordinatorSnapshotSchema } from "../src/coordinator";

const base = process.env.COMPILER_URL ?? "http://localhost:8080";
const projects = [crypto.randomUUID(), crypto.randomUUID()];
const stream = new AbortController();
async function call(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, base), init);
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
async function submit(projectId: string, text: string) {
  const id = crypto.randomUUID();
  await call(`/projects/${projectId}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Compilation-Id": id },
    body: JSON.stringify({
      mainFile: "main.tex",
      files: {
        "main.tex": `\\documentclass{article}\\begin{document}${text}\\end{document}`,
      },
    }),
  });
  return id;
}
async function ready(projectId: string, jobId: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = coordinatorSnapshotSchema.parse(
      await (await call(`/projects/${projectId}`)).json(),
    );
    if (state.current?.status === "failed")
      throw new Error(JSON.stringify(state));
    if (
      state.latestBuild?.id === jobId &&
      state.latestBuild.status === "succeeded"
    ) {
      const pdf = await call(
        `/projects/${projectId}/compilations/${jobId}.pdf`,
      );
      if (!(await pdf.text()).startsWith("%PDF-"))
        throw new Error("Invalid PDF");
      return state;
    }
    await Bun.sleep(100);
  }
  throw new Error("Build did not complete");
}
try {
  const [a, b] = projects;
  if (!a || !b) throw new Error("Missing projects");
  const events = await call(`/projects/${a}/events`, { signal: stream.signal });
  const reader = events.body?.getReader();
  if (!reader) throw new Error("Missing event stream");
  const initial = new TextDecoder().decode((await reader.read()).value);
  if (!initial.includes('"revision":0'))
    throw new Error("Opening project did not attach");
  await submit(a, "discard one");
  await submit(a, "discard two");
  const newest = await submit(a, "newest wins");
  const other = await submit(b, "separate project");
  const states = await Promise.all([ready(a, newest), ready(b, other)]);
  if (states[0]?.revision !== 3 || states[1]?.revision !== 1)
    throw new Error("Revisions crossed projects");
  const slow = await submit(a, "\\loop\\iftrue\\repeat");
  const runningDeadline = Date.now() + 5000;
  while (true) {
    const state = coordinatorSnapshotSchema.parse(
      await (await call(`/projects/${a}`)).json(),
    );
    if (state.current?.id === slow && state.current.status === "running") break;
    if (Date.now() > runningDeadline)
      throw new Error("Slow compile did not start");
    await Bun.sleep(20);
  }
  await Bun.sleep(150);
  const replacement = await submit(a, "cancelled and replaced");
  await ready(a, replacement);
  const superseded = coordinatorSnapshotSchema.shape.current
    .unwrap()
    .parse(await (await call(`/projects/${a}/jobs/${slow}`)).json());
  if (superseded.status !== "failed")
    throw new Error("Superseded job did not terminate");
  const crossed = await fetch(
    new URL(`/projects/${a}/compilations/${other}.pdf`, base),
  );
  if (crossed.status !== 404) throw new Error("Cross-project artifact exposed");
  let pushed = initial;
  while (!pushed.includes('"status":"succeeded"'))
    pushed += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  console.info(
    JSON.stringify({
      result: "passed",
      base,
      projects,
      checks: [
        "attach",
        "debounce",
        "in-flight cancellation",
        "newest revision",
        "independent engines",
        "PDF",
        "push updates",
        "artifact isolation",
      ],
    }),
  );
} finally {
  stream.abort();
}

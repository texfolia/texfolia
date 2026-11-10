import { z } from "zod";

import type { Engine } from "./jobs";
import { HttpError } from "./project";

const failure = z.object({ error: z.string(), log: z.string().optional() });

export function createEngineClient(
  fetchEngine: (request: Request) => Promise<Response>,
  baseUrl = "http://container",
): Engine {
  return async (project) => {
    const response = await fetchEngine(
      new Request(new URL("/compile", baseUrl).href, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "multipart/form-data",
        },
        body: JSON.stringify(project),
        signal: AbortSignal.timeout(90_000),
      }),
    );
    if ([400, 408, 413, 422].includes(response.status)) {
      const detail = failure.parse(await response.json());
      throw new HttpError(response.status, detail.error, detail.log);
    }
    if (!response.ok) throw new Error(`TeX host returned ${response.status}`);
    const form = await response.formData();
    const pdf = form.get("pdf");
    const log = form.get("log");
    if (!(pdf instanceof Blob) || typeof log !== "string")
      throw new Error("TeX host returned an invalid result");
    return { pdf: new Uint8Array(await pdf.arrayBuffer()), log };
  };
}

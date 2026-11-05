import { createFileRoute } from "@tanstack/react-router";
import { db, projectJob } from "@texfolia/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "#/lib/auth";

const payload = z.object({
  mainFile: z.string(),
  files: z.record(z.string(), z.string()),
});
const maxBytes = 10 * 1024 * 1024;

export const Route = createFileRoute("/api/compile/$projectId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session)
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (!z.uuid().safeParse(params.projectId).success)
          return Response.json({ error: "Project not found" }, { status: 404 });
        const project = await db.query.project.findFirst({
          columns: { id: true },
          where: {
            id: params.projectId,
            ownerId: session.user.id,
            deletedAt: { isNull: true },
          },
        });
        if (!project)
          return Response.json({ error: "Project not found" }, { status: 404 });

        const url = process.env.COMPILER_URL;
        if (!url)
          return Response.json(
            { error: "Compiler is not configured" },
            { status: 503 },
          );
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return Response.json(
            { error: "Expected application/json" },
            { status: 415 },
          );
        const reader = request.body?.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let bytes = 0;
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > maxBytes) {
            await reader.cancel();
            return Response.json(
              { error: "Project exceeds 10 MiB" },
              { status: 413 },
            );
          }
          chunks.push(new Uint8Array(value));
        }
        const body = await new Blob(chunks).text();
        try {
          payload.parse(JSON.parse(body));
        } catch {
          return Response.json(
            { error: "Invalid project sources" },
            { status: 400 },
          );
        }

        const id = crypto.randomUUID();
        await db.insert(projectJob).values({
          id,
          projectId: project.id,
          status: "running",
          sizeBytes: 0n,
          startedAt: new Date(),
        });
        const finish = (values: Partial<typeof projectJob.$inferInsert>) =>
          db
            .update(projectJob)
            .set({ ...values, finishedAt: new Date() })
            .where(eq(projectJob.id, id));

        try {
          const headers = new Headers({
            Accept: "multipart/form-data",
            "Content-Type": "application/json",
            "X-Compilation-Id": id,
          });
          if (process.env.COMPILER_TOKEN)
            headers.set(
              "Authorization",
              `Bearer ${process.env.COMPILER_TOKEN}`,
            );
          const result = await fetch(new URL("/compile", url), {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(90_000),
          });
          if (!result.ok) {
            const failure = z
              .object({ error: z.string(), log: z.string().optional() })
              .safeParse(await result.json().catch(() => undefined));
            const detail = failure.success
              ? failure.data
              : { error: "Compilation service failed" };
            await finish({ status: "failed", ...detail });
            return Response.json(detail, { status: result.status });
          }
          const form = await result.clone().formData();
          const pdf = form.get("pdf");
          const log = form.get("log");
          if (!(pdf instanceof Blob) || typeof log !== "string")
            throw new Error("Invalid compiler result");
          const location = result.headers.get("Location");
          const size = result.headers.get("X-Compilation-Size");
          if (
            location !== null &&
            (location !== `/compilations/${id}.pdf` ||
              size !== String(pdf.size))
          )
            throw new Error("Invalid stored PDF metadata");
          await finish({
            status: "succeeded",
            log,
            objectKey: location?.slice(1),
            sizeBytes: location ? BigInt(pdf.size) : 0n,
          });
          return new Response(result.body, {
            headers: {
              "Content-Type":
                result.headers.get("Content-Type") ?? "multipart/form-data",
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          // A lost response may follow a successful R2 write. The reserved job ID
          // lets the storage reconciliation script recover it without guessing ownership.
          console.error("Compile transport failed", { jobId: id, error });
          return Response.json(
            { error: "Compilation service failed" },
            { status: 502 },
          );
        }
      },
    },
  },
});

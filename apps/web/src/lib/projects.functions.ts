import { createServerFn } from "@tanstack/react-start";
import { db, project } from "@texfolia/db";
import z from "zod";

import { ensureSession } from "./auth.functions";

export const createProject = createServerFn({ method: "POST" })
  .validator(
    z.object({
      name: z.string().min(1),
    }),
  )
  .handler(async ({ data }) => {
    const session = await ensureSession();

    return db
      .insert(project)
      .values({
        ownerId: session.user.id,
        name: data.name,
      })
      .returning();
  });

export const getProjects = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await ensureSession();

    return db.query.project.findMany({
      where: {
        ownerId: session.user.id,
      },
    });
  },
);

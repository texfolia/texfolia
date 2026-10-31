import { createServerFn } from "@tanstack/react-start";
import { db } from "@texfolia/db";

import { ensureSession } from "./auth.functions";

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

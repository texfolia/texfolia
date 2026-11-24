import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { liveUserHeader } from "./client";
import { LiveAccess, liveAccessMs } from "./live-access";

const viewerSchema = z.object({
  projectId: z.string(),
  // Null for the app's own Workers, which hold no project access to lose.
  userId: z.string().nullable(),
});
type Viewer = z.infer<typeof viewerSchema>;
type Duty = "work" | "access";

/**
 * A project's live channel: hibernatable sockets that receive every snapshot,
 * and response bodies that end when their reader loses access. Subclasses own
 * the data, the access check, and any work of their own that needs an alarm.
 */
export abstract class LiveProject<E = Env> extends DurableObject<E> {
  // The frame a socket receives on connect and whenever `publish` runs.
  protected abstract liveFrame(projectId: string): string;
  // Rejects when the user cannot read the project's builds.
  protected abstract checkLiveAccess(
    projectId: string,
    userId: string,
  ): Promise<void>;
  protected work(): Promise<void> {
    return Promise.resolve();
  }

  private access: LiveAccess | undefined;
  private streams = new Map<string, Set<() => void>>();
  private catchingUp = new Set<string>();

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    // An object has one alarm. Each duty keeps its own time here.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS alarms (duty TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    );
    // Answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  private accessFor(projectId: string) {
    return (this.access ??= new LiveAccess((userId) =>
      this.checkLiveAccess(projectId, userId),
    ));
  }

  private viewer(ws: WebSocket): Viewer {
    return viewerSchema.parse(ws.deserializeAttachment());
  }

  /** Accepts a viewer's socket. The caller has already authenticated them. */
  protected async openSocket(request: Request, projectId: string) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const userId = request.headers.get(liveUserHeader);
    if (userId !== null)
      try {
        // A revocation may have passed between the route's check and this one.
        await this.accessFor(projectId).verify(userId);
      } catch {
        return new Response("Project not found", { status: 404 });
      }
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ projectId, userId } satisfies Viewer);
    this.ctx.acceptWebSocket(server, userId === null ? [] : [userId]);
    server.send(this.liveFrame(projectId));
    if (userId !== null) await this.planAccessCheck();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Ends a response body when the user it is for loses access. */
  protected async guard(response: Response, projectId: string, userId: string) {
    if (!response.ok || !response.body) return response;
    const streams = this.streams.get(userId) ?? new Set();
    this.streams.set(userId, streams);
    const { body, stop } = this.accessFor(projectId).guard(
      response.body,
      userId,
      () => {
        streams.delete(stop);
        if (!streams.size) this.streams.delete(userId);
      },
    );
    streams.add(stop);
    await this.planAccessCheck();
    return new Response(body, response);
  }

  /** Sends the current frame to every viewer, checking only unverified ones. */
  protected publish(projectId: string) {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const frame = this.liveFrame(projectId);
    const access = this.accessFor(projectId);
    const unverified = new Set<string>();
    for (const ws of sockets) {
      const { userId } = this.viewer(ws);
      if (userId === null || access.fresh(userId)) this.send(ws, frame);
      else unverified.add(userId);
    }
    for (const userId of unverified)
      this.ctx.waitUntil(this.catchUp(projectId, userId));
  }

  private async catchUp(projectId: string, userId: string) {
    if (this.catchingUp.has(userId)) return;
    this.catchingUp.add(userId);
    try {
      await this.accessFor(projectId).verify(userId);
    } catch {
      this.disconnect(userId);
      return;
    } finally {
      this.catchingUp.delete(userId);
    }
    const frame = this.liveFrame(projectId);
    for (const ws of this.ctx.getWebSockets(userId)) this.send(ws, frame);
  }

  private send(ws: WebSocket, frame: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(frame);
    } catch {
      // The socket closed first. Its viewer reconnects.
    }
  }

  private disconnect(userId: string) {
    for (const ws of this.ctx.getWebSockets(userId))
      if (ws.readyState === WebSocket.OPEN)
        ws.close(1008, "Project access could not be verified");
    for (const stop of this.streams.get(userId) ?? []) stop();
  }

  private viewers() {
    const users = new Map<string, string>();
    for (const ws of this.ctx.getWebSockets()) {
      const { projectId, userId } = this.viewer(ws);
      if (userId !== null && ws.readyState === WebSocket.OPEN)
        users.set(userId, projectId);
    }
    return users;
  }

  /**
   * Revocation paths call this, possibly inside the revoking transaction, so it
   * must not wait on Postgres. From here on nothing is delivered to these users
   * until a check, which waits behind the revocation's locks, has passed.
   */
  async invalidateAccess(userIds?: string[]) {
    this.access?.invalidate(userIds);
    this.ctx.waitUntil(this.verifyViewers(userIds));
  }

  // Closes viewers who lost access, including those nothing is sent to.
  private async verifyViewers(userIds?: string[]) {
    const users = [...this.viewers()];
    const watching = new Set([
      ...users.map(([userId]) => userId),
      ...this.streams.keys(),
    ]);
    const access = this.access ?? (users[0] && this.accessFor(users[0][1]));
    if (!access) return watching.size;
    for (const userId of watching) {
      if (userIds && !userIds.includes(userId)) continue;
      try {
        await access.verify(userId);
      } catch {
        this.disconnect(userId);
      }
    }
    return watching.size;
  }

  private async planAccessCheck() {
    const [planned] = this.ctx.storage.sql
      .exec("SELECT at FROM alarms WHERE duty = 'access'")
      .toArray();
    if (!planned) await this.plan("access", Date.now() + liveAccessMs);
  }

  /** Schedules this duty, replacing its earlier time. */
  protected async plan(duty: Duty, at: number) {
    const { sql } = this.ctx.storage;
    // An alarm set before duties existed was for work.
    const [known] = sql.exec("SELECT duty FROM alarms LIMIT 1").toArray();
    const existing = known ? null : await this.ctx.storage.getAlarm();
    if (existing !== null)
      sql.exec("INSERT OR IGNORE INTO alarms VALUES ('work', ?)", existing);
    sql.exec(
      "INSERT OR REPLACE INTO alarms VALUES (?, ?)",
      duty,
      Math.ceil(at),
    );
    await this.setNextAlarm();
  }

  private async setNextAlarm() {
    const { at } = this.ctx.storage.sql
      .exec<{ at: number | null }>("SELECT min(at) AS at FROM alarms")
      .one();
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  override async alarm() {
    const { sql } = this.ctx.storage;
    const now = Date.now();
    const duties = sql
      .exec<{ duty: Duty; at: number }>("SELECT * FROM alarms")
      .toArray();
    const due = (duty: Duty) =>
      duties.some((entry) => entry.duty === duty && entry.at <= now);
    const done = (duty: Duty) =>
      sql.exec("DELETE FROM alarms WHERE duty = ? AND at <= ?", duty, now);
    if (due("access")) {
      done("access");
      this.access?.invalidate();
      if (await this.verifyViewers()) await this.planAccessCheck();
    }
    // A failure keeps the duty due, so the runtime's retry runs it again.
    if (due("work") || !duties.length) {
      await this.work();
      done("work");
    }
    await this.setNextAlarm();
  }

  override webSocketMessage() {
    // Viewers only listen.
  }
}

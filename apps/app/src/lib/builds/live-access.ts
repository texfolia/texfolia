import { liveAccessMs } from "#/lib/projects/live-access-interval";

/** Who may receive a project's live build data, as far as this object knows. */
export class LiveAccess {
  private verified = new Map<string, number>();
  private checks = new Map<string, Promise<void>>();
  private generation = 0;

  /** `check` rejects when the user cannot read the project's builds. */
  constructor(
    private check: (userId: string) => Promise<void>,
    private now: () => number = Date.now,
  ) {}

  fresh(userId: string) {
    const at = this.verified.get(userId);
    return at !== undefined && this.now() - at < liveAccessMs;
  }

  /** Forgets everyone, or some users, so their next delivery is checked. */
  invalidate(userIds?: string[]) {
    this.generation++;
    if (userIds) for (const userId of userIds) this.verified.delete(userId);
    else this.verified.clear();
  }

  /** Resolves once the user is verified, and rejects when they are not. */
  async verify(userId: string) {
    while (!this.fresh(userId)) {
      let check = this.checks.get(userId);
      if (!check) {
        check = this.run(userId).finally(() => this.checks.delete(userId));
        this.checks.set(userId, check);
      }
      await check;
    }
  }

  private async run(userId: string) {
    const { generation } = this;
    const at = this.now();
    await this.check(userId);
    // A revocation that arrived meanwhile may not have been visible yet.
    if (generation === this.generation) this.verified.set(userId, at);
  }

  /**
   * Passes a body through while the user keeps access. Each chunk reads a flag;
   * Postgres is asked only after an invalidation or `liveAccessMs`. Losing
   * access, or `signal`, ends the stream.
   */
  guard(
    body: ReadableStream<Uint8Array>,
    userId: string,
    onEnd: () => void = () => {},
  ) {
    const reader = body.getReader();
    let ended = false;
    const end = () => {
      if (ended) return false;
      ended = true;
      onEnd();
      void reader.cancel().catch(() => {});
      return true;
    };
    let stop = () => {};
    const guarded = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          stop = () => {
            if (!end()) return;
            try {
              controller.close();
            } catch {
              // The consumer already cancelled.
            }
          };
        },
        pull: async (controller) => {
          let next;
          try {
            next = await reader.read();
          } catch (error) {
            // A truncated file must not look complete.
            if (end()) controller.error(error);
            return;
          }
          if (ended) return;
          if (next.done) {
            stop();
            return;
          }
          if (!this.fresh(userId))
            try {
              await this.verify(userId);
            } catch {
              stop();
              return;
            }
          if (!ended) controller.enqueue(next.value);
        },
        cancel: () => void end(),
      },
      { highWaterMark: 0 },
    );
    return { body: guarded, stop: () => stop() };
  }
}

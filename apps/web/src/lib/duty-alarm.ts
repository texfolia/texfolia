/**
 * Splits a Durable Object's single alarm into duties, each with its own time. An
 * object with no duty planned has no alarm, so it can stay asleep.
 */
export class DutyAlarm<Duty extends string> {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS alarms (duty TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    );
  }

  private duties() {
    return this.storage.sql
      .exec<{ duty: Duty; at: number }>("SELECT * FROM alarms")
      .toArray();
  }

  planned(duty: Duty) {
    return this.duties().find((entry) => entry.duty === duty)?.at ?? null;
  }

  /** Schedules a duty, replacing its earlier time. */
  async plan(duty: Duty, at: number) {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO alarms VALUES (?, ?)",
      duty,
      Math.ceil(at),
    );
    await this.setNext();
  }

  /** Schedules a duty unless it is already due by then. */
  async planBy(duty: Duty, at: number) {
    const planned = this.planned(duty);
    if (planned === null || planned > at) await this.plan(duty, at);
  }

  due(duty: Duty, now: number) {
    const planned = this.planned(duty);
    return planned !== null && planned <= now;
  }

  /** Forgets a duty that ran, unless it was planned again meanwhile. */
  done(duty: Duty, now: number) {
    this.storage.sql.exec(
      "DELETE FROM alarms WHERE duty = ? AND at <= ?",
      duty,
      now,
    );
  }

  idle() {
    return this.duties().length === 0;
  }

  async setNext() {
    const at = Math.min(...this.duties().map((entry) => entry.at));
    if (Number.isFinite(at)) await this.storage.setAlarm(at);
  }
}

/** The alarm of a Durable Object's storage. */
export type AlarmStorage = {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

const maintenanceMs = 60_000;

/** Keeps maintenance scheduled for as long as the pool has anything to maintain. */
export class MaintenanceAlarm {
  private claims = 0;

  constructor(private storage: AlarmStorage) {}

  /** Runs a claim. One that never returns is still maintained. */
  async claim<A>(run: () => Promise<A>): Promise<A> {
    // Counted before anything is awaited, so `fire` cannot miss it.
    this.claims++;
    try {
      if ((await this.storage.getAlarm()) === null) await this.schedule();
      return await run();
    } finally {
      this.claims--;
    }
  }

  /** Runs when the alarm does. An idle pool is left alone until its next claim. */
  async fire(maintain: () => Promise<void>, idle: () => boolean) {
    // Scheduled first, so a failure cannot leave the pool unattended.
    await this.schedule();
    await maintain();
    // Nothing may be awaited in between: a claim either counts here already, or
    // reads the alarm after it has been deleted.
    if (this.claims === 0 && idle()) await this.storage.deleteAlarm();
  }

  private schedule() {
    return this.storage.setAlarm(Date.now() + maintenanceMs);
  }
}

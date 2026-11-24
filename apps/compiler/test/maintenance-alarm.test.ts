import { expect, test } from "bun:test";

import { MaintenanceAlarm } from "../src/maintenance-alarm";

// Durable Object storage answers later, but in the order it was asked.
function harness() {
  let at: number | null = null;
  let turn = Promise.resolve();
  const next = <A>(run: () => A) => {
    const answer = turn.then(() => Bun.sleep(1)).then(run);
    turn = answer.then(() => {});
    return answer;
  };
  const alarm = new MaintenanceAlarm({
    getAlarm: () => next(() => at),
    setAlarm: (time) => next(() => void (at = time)),
    deleteAlarm: () => next(() => void (at = null)),
  });
  return { alarm, scheduled: () => next(() => at !== null) };
}

test("a claim schedules maintenance before it runs, and an idle pool drops it", async () => {
  const { alarm, scheduled } = harness();
  expect(await alarm.claim(scheduled)).toBe(true);
  await alarm.fire(
    async () => expect(await scheduled()).toBe(true),
    () => false,
  );
  expect(await scheduled()).toBe(true);
  await alarm.fire(
    async () => {},
    () => true,
  );
  expect(await scheduled()).toBe(false);
});

test("failed maintenance runs again", async () => {
  const { alarm, scheduled } = harness();
  await expect(
    alarm.fire(
      () => Promise.reject(new Error("fixture")),
      () => true,
    ),
  ).rejects.toThrow("fixture");
  expect(await scheduled()).toBe(true);
});

test("a failed claim is no longer counted", async () => {
  const { alarm, scheduled } = harness();
  await expect(
    alarm.claim(() => Promise.reject(new Error("fixture"))),
  ).rejects.toThrow("fixture");
  await alarm.fire(
    async () => {},
    () => true,
  );
  expect(await scheduled()).toBe(false);
});

// However a claim and the alarm interleave, a running pool stays scheduled.
for (const delayMs of [0, 1, 2, 3, 4, 5, 6])
  test(`a claim ${delayMs} ms into the alarm keeps maintenance scheduled`, async () => {
    const { alarm, scheduled } = harness();
    let running = false;
    const firing = alarm.fire(
      () => Bun.sleep(2),
      () => !running,
    );
    await Bun.sleep(delayMs);
    await Promise.all([
      firing,
      alarm.claim(async () => {
        await Bun.sleep(1);
        running = true;
      }),
    ]);
    expect(await scheduled()).toBe(true);
  });

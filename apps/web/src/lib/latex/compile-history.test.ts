import { expect, test } from "bun:test";

import {
  browserClock,
  compileTimeline,
  compileTotalMs,
  containerStart,
  parseJobTimeline,
} from "./compile-history";

const received = Date.parse("2026-11-18T12:00:00.000Z");
const at = (ms: number) => new Date(received + ms).toISOString();
const timing = parseJobTimeline({
  web: { receivedAt: at(0) },
  compiler: {
    acceptedAt: at(20),
    debounceMs: 300,
    delivery: "direct",
    startedAt: at(320),
    containerStartMs: 900,
    bootMs: 120,
    archiveStatus: "restored",
    archiveFetchMs: 40,
    archiveUnpackMs: 60,
    compileMs: 500,
    outputMs: 50,
    firstPdfAt: at(1700),
    engineFinishedAt: at(1780),
    publishedAt: at(1830),
    publishMs: 50,
    engine: "tectonic",
    // Unknown compiler fields remain accepted.
    plan: "free",
  },
  client: {
    outcome: "rendered",
    // Sent 30 ms after the action; the response arrived 130 ms after the
    // action; the route spent 60 ms. The one-way trip is (100 - 60) / 2.
    requestSentMs: 30,
    submissionMs: 130,
    serverMs: 60,
    pollingMs: 1800,
    downloadMs: 10,
    previewMs: 40,
    actionToPdfMs: 2000,
    keystrokeToPdfMs: null,
    firstPdfByteMs: 1760,
    notifiedMs: 1900,
  },
});

test("browser deltas map onto receivedAt with half the network round trip", () => {
  const clock = browserClock(timing)!;
  expect(clock.roundTripMs).toBe(40);
  // The request arrived 30 + 20 ms after the action.
  expect(clock.toServer(50)).toBe(received);
  expect(clock.toServer(1900)).toBe(received + 1850);
});

test("the timeline orders server and mapped browser events", () => {
  const events = compileTimeline({
    createdAt: at(5),
    finishedAt: at(1900),
    timing,
  });
  expect(events.map((event) => event.key)).toEqual([
    "sent",
    "received",
    "accepted",
    "debounce",
    "started",
    "container",
    "latex",
    "first-pdf",
    "browser-first-pdf",
    "finished",
    "published",
    "notified",
    "rendered",
  ]);
  const byKey = new Map(events.map((event) => [event.key, event]));
  expect(byKey.get("sent")).toMatchObject({
    at: received - 20,
    clock: "browser",
  });
  expect(byKey.get("received")).toMatchObject({
    at: received,
    clock: "server",
  });
  expect(byKey.get("debounce")).toMatchObject({
    label: "Debounce wait",
    durationMs: 300,
  });
  expect(byKey.get("started")?.label).toBe("Compile started");
  expect(byKey.get("container")?.label).toBe("Cold start, cache restored");
  // LaTeX ran before output processing at the end of the engine request.
  expect(byKey.get("latex")).toMatchObject({
    start: received + 1230,
    at: null,
    approximate: true,
  });
  expect(byKey.get("published")).toMatchObject({
    at: received + 1830,
    start: received + 1780,
  });
  expect(byKey.get("rendered")).toMatchObject({
    at: received + 1950,
    durationMs: 40,
  });
  expect(compileTotalMs(timing)).toBe(2000);
});

test("the queue label appears only when the overflow path ran", () => {
  const overflow = compileTimeline({
    createdAt: at(0),
    finishedAt: null,
    timing: {
      ...timing,
      compiler: { ...timing.compiler, delivery: "overflow" },
    },
  });
  expect(overflow.find((event) => event.key === "started")?.label).toBe(
    "Started from the overflow queue",
  );
  const direct = compileTimeline({
    createdAt: at(0),
    finishedAt: null,
    timing,
  });
  expect(direct.some((event) => /queue/i.test(event.label))).toBe(false);
});

test("browser events are omitted without clock anchors", () => {
  const events = compileTimeline({
    createdAt: at(0),
    finishedAt: null,
    timing: {
      ...timing,
      client: { ...timing.client!, requestSentMs: undefined },
    },
  });
  expect(events.some((event) => event.clock === "browser")).toBe(false);
});

test("jobs that never reached the compiler show receipt and finish", () => {
  const events = compileTimeline({
    createdAt: at(0),
    finishedAt: at(80),
    timing: parseJobTimeline({ web: { receivedAt: at(0) } }),
  });
  expect(events.map((event) => event.key)).toEqual(["received", "recorded"]);
});

test("invalid timeline parts are dropped individually", () => {
  const parsed = parseJobTimeline({
    web: { receivedAt: "yesterday" },
    compiler: { startedAt: at(1) },
  });
  expect(parsed.web).toBeUndefined();
  expect(parsed.compiler?.startedAt).toBe(at(1));
  expect(parseJobTimeline(null)).toEqual({
    web: undefined,
    compiler: undefined,
    client: undefined,
  });
});

test("container start distinguishes cold, warm, and prewarmed", () => {
  expect(containerStart({ archiveStatus: "warm", cacheUsed: true }).label).toBe(
    "Warm container, cache hit",
  );
  expect(containerStart({ archiveStatus: "missing" }).kind).toBe("cold");
  expect(
    containerStart({ archiveStatus: "restored", prewarmed: true }).kind,
  ).toBe("warm");
  expect(containerStart(undefined).kind).toBe("unknown");
});

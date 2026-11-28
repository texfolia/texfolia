import { describe, expect, test } from "bun:test";

import { mergeCommentThread } from "./merge";

type TestThread = {
  id: string;
  createdAt: Date;
  body: string;
};

type TestComments = {
  userId: string;
  canComment: boolean;
  canModerate: boolean;
  threads: TestThread[];
};

const makeThread = (id: string, createdAt: string, body = "hello") => ({
  id,
  createdAt: new Date(createdAt),
  body,
});

const base: TestComments = {
  userId: "user-1",
  canComment: true,
  canModerate: true,
  threads: [
    makeThread("t-1", "2026-01-01T00:00:00Z", "first"),
    makeThread("t-3", "2026-01-03T00:00:00Z", "third"),
  ],
};

describe("mergeCommentThread", () => {
  test("returns undefined when initial comments have not loaded", () => {
    expect(
      mergeCommentThread<TestThread, TestComments>(undefined, {
        userId: "user-1",
        canComment: true,
        canModerate: true,
        threadId: "t-1",
        thread: makeThread("t-1", "2026-01-01T00:00:00Z"),
      }),
    ).toBeUndefined();
  });

  test("inserts a new thread in createdAt order", () => {
    const next = mergeCommentThread(base, {
      userId: "user-1",
      canComment: true,
      canModerate: true,
      threadId: "t-2",
      thread: makeThread("t-2", "2026-01-02T00:00:00Z", "second"),
    });
    expect(next?.threads.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
  });

  test("updates an existing thread in place without touching others", () => {
    const next = mergeCommentThread(base, {
      userId: "user-1",
      canComment: true,
      canModerate: true,
      threadId: "t-1",
      thread: makeThread("t-1", "2026-01-01T00:00:00Z", "edited"),
    });
    expect(next?.threads.map((t) => t.body)).toEqual(["edited", "third"]);
  });

  test("removes a deleted thread when thread is null", () => {
    const next = mergeCommentThread(base, {
      userId: "user-1",
      canComment: true,
      canModerate: true,
      threadId: "t-1",
      thread: null,
    });
    expect(next?.threads.map((t) => t.id)).toEqual(["t-3"]);
  });

  test("merges resolved mention profiles from updated threads", () => {
    type MentionProfile = {
      id: string;
      name: string;
      image: null;
      status: "active";
    };
    const withMentions: TestComments & {
      mentions: Record<string, MentionProfile>;
    } = {
      ...base,
      mentions: {
        "user-1": {
          id: "user-1",
          name: "Ada",
          image: null,
          status: "active",
        },
      },
    };
    const next = mergeCommentThread(withMentions, {
      userId: "user-1",
      canComment: true,
      canModerate: true,
      threadId: "t-2",
      thread: makeThread("t-2", "2026-01-02T00:00:00Z", "second"),
      mentions: {
        "user-2": {
          id: "user-2",
          name: "Grace",
          image: null,
          status: "active",
        },
      },
    });
    expect(next?.mentions).toEqual({
      "user-1": { id: "user-1", name: "Ada", image: null, status: "active" },
      "user-2": { id: "user-2", name: "Grace", image: null, status: "active" },
    });
  });
});

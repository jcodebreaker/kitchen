import { describe, expect, it } from "vitest";
import { editedAfterLabel, repliesOf, ticketOf } from "./github.ts";

describe("github ticket source (pure)", () => {
  it("turns an issue into a ticket with its number and URL", () => {
    const t = ticketOf({ number: 12, title: "Show project count", body: "On /home", url: "https://github.com/a/b/issues/12", author: { login: "alice" } });
    expect(t.ref).toEqual({ source: "github", id: "12", url: "https://github.com/a/b/issues/12" });
    expect(t.body).toBe("Show project count\n\nOn /home");
    expect(t.author).toBe("alice");
  });
  it("counts only later replies by the author or an operator, never Kitchen's own", () => {
    const since = "2026-11-22T10:00:00Z";
    const c = (login: string, at: string, body = "answer") => ({ body, createdAt: at, author: { login } });
    const got = repliesOf(
      [
        c("alice", "2026-11-22T09:00:00Z", "before"),
        c("mallory", "2026-11-22T11:00:00Z", "stranger"),
        c("kitchen-bot", "2026-11-22T11:00:00Z", "q <!-- kitchen:ask/m1 -->"),
        c("Alice", "2026-11-22T11:00:00Z", "author"),
        c("ops", "2026-11-22T12:00:00Z", "operator"),
      ],
      { since, author: "alice", operators: ["ops"] },
    );
    expect(got).toEqual(["author", "operator"]);
  });
  it("a reply right after the question counts even when the job moved later (position, not the local clock)", () => {
    const c = (login: string, at: string, body: string) => ({ body, createdAt: at, author: { login } });
    const comments = [c("kitchen-bot", "2026-11-22T10:00:00Z", "q <!-- kitchen:ask/m1 -->"), c("alice", "2026-11-22T10:00:01Z", "quick answer")];
    expect(repliesOf(comments, { since: "2026-11-22T10:00:05Z", author: "alice", operators: [] })).toEqual(["quick answer"]);
  });
  it("an issue edited after its latest label event is not taken in", () => {
    const labeled = (at: string, label = "kitchen") => ({ type: "labeled" as const, at, label });
    expect(editedAfterLabel({ lastEditedAt: null, events: [labeled("2026-11-22T10:00:00Z")] }, "kitchen")).toBeNull();
    expect(editedAfterLabel({ lastEditedAt: "2026-11-22T09:00:00Z", events: [labeled("2026-11-22T10:00:00Z")] }, "kitchen")).toBeNull();
    expect(editedAfterLabel({ lastEditedAt: "2026-11-22T11:00:00Z", events: [labeled("2026-11-22T10:00:00Z")] }, "kitchen")).toBe("2026-11-22T11:00:00Z");
    expect(
      editedAfterLabel({ lastEditedAt: null, events: [labeled("2026-11-22T10:00:00Z"), { type: "renamed", at: "2026-11-22T10:30:00Z" }] }, "kitchen"),
    ).toBe("2026-11-22T10:30:00Z");
    // labelled again after the edit: vouched for
    expect(
      editedAfterLabel({ lastEditedAt: "2026-11-22T11:00:00Z", events: [labeled("2026-11-22T10:00:00Z"), labeled("2026-11-22T12:00:00Z")] }, "kitchen"),
    ).toBeNull();
    // another label's event doesn't count
    expect(editedAfterLabel({ lastEditedAt: "2026-11-22T11:00:00Z", events: [labeled("2026-11-22T12:00:00Z", "bug")] }, "kitchen")).toBe(
      "2026-11-22T11:00:00Z",
    );
  });
});

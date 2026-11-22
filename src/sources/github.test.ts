import { describe, expect, it } from "vitest";
import { repliesOf, ticketOf } from "./github.ts";

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
});

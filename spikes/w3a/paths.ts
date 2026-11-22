// The W1 stage paths that relied on the W1 stubs (spikes/w1/paths.ts: bug, gap,
// inconclusive, paused), ported to fixture A: the scripted agent (fake-agent.ts),
// the real Toolkit, Docker and engine, up to review (ready and report are W3b/W4).
//   node spikes/w3a/paths.ts [scenario…] <scratch>
// Scenarios: repro-retry gap bad-gap inconclusive backoff (default: all, one Docker stack at a time).
// Each prints PASS/FAIL lines; exit 1 on any miss.
import fs from "node:fs";
import path from "node:path";
import { readFakeForge } from "../../src/forge/forge.ts";
import { check, finish, HERE, jobDir, jobOf, kitchen, kitchenContainers, makeFixtureRepo, type Repo, sleep, stagesOf, stepUntil, ticket } from "./lib.ts";

const ALL = ["repro-retry", "gap", "bad-gap", "inconclusive", "backoff"];
const args = process.argv.slice(2);
const root = path.resolve(args.filter((a) => !ALL.includes(a))[0] ?? path.join(HERE, ".work"));
const picked = args.filter((a) => ALL.includes(a));
fs.mkdirSync(root, { recursive: true });
const STOP = ["review", "needs-human", "needs-info", "rejected", "done", "paused"];
const TICKET = "Dark mode doesn't stick: I turn it on in Settings, it says Saved, but after a reload the app is light again.";
const yaml = (forge: "local" | "fake") => `concurrency: 1
round_limit: 3
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }
checks:
  - { name: syntax, run: "node --check server.js" }
backoff: { base_sec: 1, max_sec: 2 }
forge: { kind: ${forge} }
`;
const read = (r: Repo, id: string, rel: string) => {
  const f = path.join(jobDir(r, id), rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};
function start(name: string, forge: "local" | "fake" = "local") {
  const r = makeFixtureRepo(root, `paths-${name}`, { yaml: yaml(forge), bug: true });
  const id = ticket(r, `${TICKET}\n\nscenario: ${name}`);
  const log = path.join(root, `paths-${name}.log`);
  fs.writeFileSync(log, "");
  return { r, id, log };
}
const walk = (r: Repo, id: string) => stagesOf(r, id).join(" → ");
const clean = (r: Repo, id: string, label: string) =>
  check(
    `${label}: no container of this job left running`,
    kitchenContainers(jobOf(r, id).slotId).length === 0,
    kitchenContainers(jobOf(r, id).slotId).join(" "),
  );

const SCENARIOS: Record<string, () => Promise<void>> = {
  // W1 "bug": not reproduced once, then reproduced. Here the first try's drive waits for a heading that
  // never shows: a timed-out wait for something other than what the expect asks is a broken proof.
  async "repro-retry"() {
    const { r, id, log } = start("repro-retry");
    stepUntil(r, id, STOP, { max: 40, log });
    const w = walk(r, id);
    check("repro-retry: path", w === "intake → spec → repro → repro → build → gate → drives → verify → review", w);
    const one = JSON.parse(read(r, id, "repro-1.json") || "{}") as { status?: string; failedAsExpected?: boolean; why?: string };
    check(
      "repro-retry: try 1 (a wait for an unrelated heading timed out) is not a reproduction",
      one.status === "step-failed" && one.failedAsExpected === false && /Preferences/.test(one.why ?? ""),
      `${one.status}: ${one.why}`,
    );
    const two = JSON.parse(read(r, id, "repro-2.json") || "{}") as { status?: string; failedAsExpected?: boolean; why?: string };
    check("repro-retry: try 2 failed as expected on the base", two.failedAsExpected === true && two.status === "assert-fail", `${two.status}: ${two.why}`);
    check("repro-retry: the repro could fix its own drive from try 1 (it isn't on the base)", /theme\.md/.test(JSON.stringify(jobOf(r, id).reproFiles)));
    clean(r, id, "repro-retry");
  },

  // W1 "gap": spec → toolkit → spec (returnTo spec) and drives → toolkit → drives (returnTo drives).
  async gap() {
    const { r, id, log } = start("gap");
    stepUntil(r, id, STOP, { max: 40, log });
    const w = walk(r, id);
    check("gap: spec names a missing primitive → toolkit → spec", w.startsWith("intake → spec → toolkit → spec → repro → build"), w);
    check("gap: drives names one → toolkit → drives → verify → review", w.endsWith("drives → toolkit → drives → verify → review"), w);
    const j = jobOf(r, id);
    check(
      "gap: two smith attempts, toolkitRef set, no gap left",
      j.smith.attempts === 2 && !!j.toolkitRef && j.gap === null,
      `${j.smith.attempts} ${j.toolkitRef}`,
    );
    check("gap: the spec-lint refusal named the primitive", /needs primitive hover/.test(read(r, id, "spec-refused.md")));
    clean(r, id, "gap");
  },

  // Review fix: free text in GAP: is a failed drives write (counts toward the cap), not a Toolkit gap.
  async "bad-gap"() {
    const { r, id, log } = start("bad-gap");
    stepUntil(r, id, STOP, { max: 40, log });
    const w = walk(r, id);
    check(
      "bad-gap: a free-text GAP is a failed write: drives → drives → verify, no toolkit stage",
      w.endsWith("gate → drives → drives → verify → review") && !w.includes("toolkit"),
      w,
    );
    const c1 = read(r, id, "rounds/1/drives-check-1.md");
    check("bad-gap: the check says why", /names no missing primitive/.test(c1), c1.split("\n").find((l) => l.includes("GAP")) ?? c1.slice(0, 200));
    check("bad-gap: no smith ran", jobOf(r, id).smith.attempts === 0);
    clean(r, id, "bad-gap");
  },

  // W1 "inconclusive": free retry, paused(toolkit-ticket), ticket closed, twice more → needs-human; feedback → verify → review.
  async inconclusive() {
    const { r, id, log } = start("inconclusive", "fake");
    stepUntil(r, id, STOP, { max: 40, log });
    let j = jobOf(r, id);
    const forgeFile = path.join(r.dir, ".kitchen", "fake-forge.json");
    check(
      "inconclusive: free retry, then paused(toolkit-ticket), no round spent",
      j.stage === "paused" && j.waitFor === "toolkit-ticket" && j.round === 1 && !!j.toolkitTicketRef,
      `${j.stage} ${j.waitFor} ${j.toolkitTicketRef} round ${j.round}`,
    );
    const tickets = readFakeForge(forgeFile).tickets;
    check("inconclusive: the Toolkit ticket was filed once", tickets.length === 1 && tickets[0].calls === 1, JSON.stringify(tickets));
    fs.appendFileSync(log, kitchen(r, ["run", "--once", id]).out);
    check("inconclusive: still paused while the ticket is open", jobOf(r, id).stage === "paused");
    const s = readFakeForge(forgeFile);
    s.tickets[0].closed = true;
    fs.writeFileSync(forgeFile, JSON.stringify(s, null, 2));
    stepUntil(r, id, ["review", "needs-human", "rejected"], { max: 20, log });
    j = jobOf(r, id);
    check(
      "inconclusive: INCONCLUSIVE twice more after the ticket → needs-human, escalated from verify",
      j.stage === "needs-human" && j.escalatedFrom === "verify",
      `${j.stage} ${j.pausedReason}`,
    );
    const fb = kitchen(r, ["feedback", id, "The Toolkit is fixed, try again"]).out;
    check("inconclusive: feedback → verify (where it escalated from)", /needs-human → verify/.test(fb), fb.trim());
    stepUntil(r, id, STOP, { max: 20, log });
    const w = walk(r, id);
    check(
      "inconclusive: path",
      w.endsWith("drives → verify → verify → paused → verify → verify → needs-human → verify → review") && jobOf(r, id).round === 1,
      w,
    );
    clean(r, id, "inconclusive");
  },

  // W1 "backoff": rate limited → paused(backoff) with until; resumed after the time, never needs-human.
  async backoff() {
    const { r, id, log } = start("backoff");
    stepUntil(r, id, STOP, { max: 40, log });
    const j = jobOf(r, id);
    check(
      "backoff: a rate-limited builder → paused(backoff) with until",
      j.stage === "paused" && j.waitFor === "backoff" && !!j.until,
      `${j.stage} ${j.waitFor} ${j.until}`,
    );
    await sleep(2500);
    stepUntil(
      r,
      id,
      STOP.filter((x) => x !== "paused"),
      { max: 40, log },
    );
    const w = walk(r, id);
    check("backoff: path", w === "intake → spec → repro → build → paused → build → gate → drives → verify → review", w);
    clean(r, id, "backoff");
  },
};

for (const name of picked.length ? picked : ALL) {
  console.log(`--- ${name}`);
  await SCENARIOS[name]();
}
finish("w3a paths");

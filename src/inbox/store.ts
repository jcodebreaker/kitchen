// The outer loop's inbox (ADR 0022 §6): `.kitchen/inbox/<item>/item.json` (with the triage evidence beside it) and
// `.kitchen/inbox/proposals/<id>.json`. Single writer: only these verbs write it (`kitchen inbox …`, `kitchen
// collect`, and the lanes adding Kitchen's own findings), each under the inbox lock; the dashboard calls the same
// functions. Nothing here builds anything: `run` files the chosen proposals as jobs at intake, like `kitchen ticket`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileTicket } from "../engine/control.ts";
import type { JobFrom } from "../engine/machine.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { withFileLock } from "../lock.ts";

export type ItemSrc = {
  /** The source's name (`github-shop`, `kitchen`), its kind, the chip ("GitHub #17"), who reported it, the link back. */
  source: string;
  kind: string;
  label: string;
  ref: string;
  by?: string;
  url?: string;
  /** Kitchen findings: the job or verify run it came from. */
  job?: string;
};
export type Item = {
  id: string;
  /** `source:native_id`: `github:o/r#17`, `slack:C0123:1732440000.000200`, `kitchen:003:qa:2.1`. */
  key: string;
  /** The content hash: the same key with another hash is a new sighting (the report was edited). */
  hash: string;
  at: string;
  collectedAt: string;
  text: string;
  src: ItemSrc;
  /** 2 and up: the same report again, edited. */
  sighting?: number;
};
export const VERDICTS = ["propose", "unclear", "duplicate", "fixed", "not-ours"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type PState = "open" | "held" | "aside" | "run" | "removed";
export const PRIOS = ["P1", "P2", "P3"] as const;
export type Prio = (typeof PRIOS)[number];
export type Proposal = {
  id: string;
  title: string;
  /** What the intake agent reads. */
  text: string;
  items: string[];
  verdict: Verdict;
  state: PState;
  kind: "bug" | "feature" | "chore" | null;
  risk: "low" | "medium" | "high" | null;
  prio: Prio | null;
  /** The priority's one-line reason. */
  why: string | null;
  /** How triage checked it: the line under the title, the steps, evidence files (paths under .kitchen/inbox/), the sha. */
  ev?: { line: string; steps?: string[]; files?: string[]; shot?: string; cap?: string; sha?: string };
  /** unclear: what to settle with the person (ADR 0020). */
  questions?: string[];
  /** duplicate: of which job or item; duplicate/fixed/not ours: why. */
  of?: string;
  vwhy?: string;
  at: string;
  by: "triage" | "you";
  heldAt?: string;
  edited?: boolean;
  /** run: the job it became. */
  job?: string;
  /** removed: the state to bring it back to. */
  prev?: PState;
};

export const inboxDir = (repo: string) => path.join(kitchenDir(repo), "inbox");
export const itemDir = (repo: string, id: string) => path.join(inboxDir(repo), id);
const proposalsDir = (repo: string) => path.join(inboxDir(repo), "proposals");
const proposalFile = (repo: string, id: string) => path.join(proposalsDir(repo), `${id}.json`);
const ITEM_ID = /^i-(\d+)$/;
const PROPOSAL_ID = /^p(\d+)$/;
export const isItemId = (s: string) => ITEM_ID.test(s);
export const isProposalId = (s: string) => PROPOSAL_ID.test(s);

export const withInbox = <T>(repo: string, fn: () => Promise<T>) => withFileLock(path.join(inboxDir(repo), ".lock"), fn);
const hashOf = (s: string) => createHash("sha256").update(s.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
const nextOf = (ids: string[], re: RegExp) => ids.reduce((m, id) => Math.max(m, Number(re.exec(id)?.[1] ?? 0)), 0) + 1;

export function listItems(repo: string): Item[] {
  const d = inboxDir(repo);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => ITEM_ID.test(f))
    .flatMap((id) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(d, id, "item.json"), "utf8")) as Item];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

export function listProposals(repo: string): Proposal[] {
  const d = proposalsDir(repo);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json") && PROPOSAL_ID.test(f.slice(0, -5)))
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as Proposal];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function getProposal(repo: string, id: string): Proposal {
  if (!isProposalId(id)) throw new Error(`${id} isn't a proposal id (p1, p2…)`);
  try {
    return JSON.parse(fs.readFileSync(proposalFile(repo, id), "utf8")) as Proposal;
  } catch {
    throw new Error(`no proposal ${id} (kitchen inbox list)`);
  }
}
const saveProposal = (repo: string, p: Proposal) => writeAtomic(proposalFile(repo, p.id), `${JSON.stringify(p, null, 2)}\n`);

/** Items no proposal covers yet: what the next triage reads. */
export function untriaged(repo: string, items = listItems(repo), proposals = listProposals(repo)): Item[] {
  const covered = new Set(proposals.flatMap((p) => p.items));
  return items.filter((i) => !covered.has(i.id));
}

export type NewItem = { key: string; text: string; hashText?: string; at?: string; src: ItemSrc };
export type Added = { item: Item; added: "new" | "sighting" } | { item: Item; added: "seen" };

/**
 * Add what a source read, once: the same key with the same content hash is already in (seen); the same key with
 * another hash is the report edited, a new sighting (a new item, so triage reads the new words). Caller holds the lock.
 */
function addLocked(repo: string, n: NewItem, now: Date, items: Item[]): Added {
  if (!n.key.trim()) throw new Error("an item needs a key (source:id)");
  if (!n.text.trim()) throw new Error("an item needs some text");
  const hash = hashOf(n.hashText ?? n.text);
  const same = items.filter((i) => i.key === n.key);
  const seen = same.find((i) => i.hash === hash);
  if (seen) return { item: seen, added: "seen" };
  const id = `i-${nextOf(
    items.map((i) => i.id),
    ITEM_ID,
  )}`;
  const item: Item = {
    id,
    key: n.key,
    hash,
    at: n.at ?? now.toISOString(),
    collectedAt: now.toISOString(),
    text: n.text.trim().slice(0, 20_000),
    src: n.src,
    ...(same.length ? { sighting: same.length + 1 } : {}),
  };
  fs.mkdirSync(itemDir(repo, id), { recursive: true });
  writeAtomic(path.join(itemDir(repo, id), "item.json"), `${JSON.stringify(item, null, 2)}\n`);
  items.push(item);
  return { item, added: same.length ? "sighting" : "new" };
}

/** `kitchen inbox add`, and every source read: the items added (new or a sighting); the ones already in are skipped. */
export async function addItems(repo: string, ns: NewItem[], now = new Date()): Promise<Added[]> {
  if (!ns.length) return [];
  return withInbox(repo, async () => {
    const items = listItems(repo);
    return ns.map((n) => addLocked(repo, n, now, items));
  });
}

const need = (cond: unknown, why: string) => {
  if (!cond) throw new Error(why);
};

/** Copy evidence files next to the first item the proposal covers; their paths, relative to the inbox. */
function keepEvidence(repo: string, pid: string, item: string, files: string[]): string[] {
  return files.map((f, n) => {
    const src = path.resolve(f);
    need(fs.existsSync(src) && fs.statSync(src).isFile(), `evidence ${f}: no such file`);
    need(fs.statSync(src).size <= 10 * 1024 * 1024, `evidence ${f}: over 10 MB`);
    const name = `${pid}-${n + 1}-${path.basename(src).replace(/[^\w.-]+/g, "_")}`;
    fs.mkdirSync(path.join(itemDir(repo, item), "evidence"), { recursive: true });
    fs.copyFileSync(src, path.join(itemDir(repo, item), "evidence", name));
    return `${item}/evidence/${name}`;
  });
}

export type ProposeInput = {
  title: string;
  text: string;
  items: string[];
  kind: string;
  prio: string;
  why: string;
  risk?: string;
  line?: string;
  steps?: string[];
  evidence?: string[];
  sha?: string;
  cap?: string;
};

/** Triage's verdict "propose": a ticket the person may run. */
export async function propose(repo: string, o: ProposeInput, now = new Date()): Promise<Proposal> {
  need(o.title?.trim(), "--title: the ticket's title");
  need(o.text?.trim(), "--text: the ticket text the intake agent reads");
  need(["bug", "feature", "chore"].includes(o.kind), "--kind: bug, feature or chore");
  need((PRIOS as readonly string[]).includes(o.prio), "--prio: P1, P2 or P3");
  need(o.why?.trim(), "--why: the priority's reason, one line");
  need(!o.risk || ["low", "medium", "high"].includes(o.risk), "--risk: low, medium or high");
  return withInbox(repo, async () => {
    const id = newProposalId(repo);
    const items = checkItems(repo, o.items);
    const files = keepEvidence(repo, id, items[0], o.evidence ?? []);
    const shot = files.find((f) => /\.(png|jpe?g)$/i.test(f));
    const p: Proposal = {
      id,
      title: o.title.trim().slice(0, 120),
      text: o.text.trim(),
      items,
      verdict: "propose",
      state: "open",
      kind: o.kind as Proposal["kind"],
      risk: (o.risk as Proposal["risk"]) ?? null,
      prio: o.prio as Prio,
      why: o.why.trim(),
      ev: {
        line: o.line?.trim() || "Proposed by triage",
        ...(o.steps?.length ? { steps: o.steps.map((s) => s.trim()).filter(Boolean) } : {}),
        ...(files.length ? { files } : {}),
        ...(shot ? { shot, cap: o.cap ?? "" } : {}),
        ...(o.sha ? { sha: o.sha.slice(0, 12) } : {}),
      },
      at: now.toISOString(),
      by: "triage",
    };
    saveProposal(repo, p);
    return p;
  });
}

function newProposalId(repo: string): string {
  return `p${nextOf(
    listProposals(repo).map((p) => p.id),
    PROPOSAL_ID,
  )}`;
}

function checkItems(repo: string, ids: string[]): string[] {
  need(ids.length, "--item: the inbox items it covers (i-1 …)");
  const all = new Set(listItems(repo).map((i) => i.id));
  for (const i of ids) need(all.has(i), `no inbox item ${i}`);
  return [...new Set(ids)];
}

export type VerdictInput = { verdict: string; reason?: string; of?: string; title?: string; questions?: string[] };

/**
 * `kitchen inbox verdict`. On items (triage): duplicate, fixed or not ours sets them aside with the reason; unclear
 * proposes them to be refined with the person (the questions). On a proposal (the person): `propose` brings a
 * set-aside one to Proposed ("Propose anyway").
 */
export async function verdict(repo: string, ids: string[], o: VerdictInput, now = new Date()): Promise<Proposal> {
  need((VERDICTS as readonly string[]).includes(o.verdict), `the verdict is ${VERDICTS.join(", ")}`);
  return withInbox(repo, async () => {
    if (ids.length === 1 && isProposalId(ids[0])) {
      const p = getProposal(repo, ids[0]);
      need(o.verdict === "propose", `a proposal takes the verdict propose ("Propose anyway"); set one aside with kitchen inbox remove ${p.id}`);
      need(p.state === "aside" || p.verdict === "unclear", `${p.id} is ${p.state === "open" ? "proposed already" : p.state}`);
      const n: Proposal = {
        ...p,
        verdict: "propose",
        state: "open",
        kind: p.kind ?? "bug",
        text: p.text || listItems(repo).find((i) => i.id === p.items[0])?.text || p.title,
        ev: { line: p.state === "aside" ? "Set aside by triage · proposed by you" : "Proposed by you" },
        by: "you",
      };
      delete n.of;
      delete n.vwhy;
      delete n.questions;
      saveProposal(repo, n);
      return n;
    }
    const items = checkItems(repo, ids);
    const first = listItems(repo).find((i) => i.id === items[0]) as Item;
    const title = (o.title?.trim() || first.text.split("\n")[0]).slice(0, 120);
    if (o.verdict === "propose") throw new Error("to propose items, use kitchen inbox propose (title, text, priority)");
    if (o.verdict === "unclear") {
      need(o.questions?.length, "--question: what to settle with the person (one or more)");
      const p: Proposal = {
        id: newProposalId(repo),
        title,
        text: first.text,
        items,
        verdict: "unclear",
        state: "open",
        kind: null,
        risk: null,
        prio: null,
        why: null,
        questions: o.questions,
        at: now.toISOString(),
        by: "triage",
      };
      saveProposal(repo, p);
      return p;
    }
    need(o.reason?.trim(), "--reason: why, in a sentence (the person reads it)");
    need(o.verdict !== "duplicate" || o.of?.trim(), "--of: the job or item it duplicates");
    const p: Proposal = {
      id: newProposalId(repo),
      title,
      text: "",
      items,
      verdict: o.verdict as Verdict,
      state: "aside",
      kind: null,
      risk: null,
      prio: null,
      why: null,
      vwhy: (o.reason as string).trim(),
      ...(o.of ? { of: o.of.trim() } : {}),
      at: now.toISOString(),
      by: "triage",
    };
    saveProposal(repo, p);
    return p;
  });
}

async function change(repo: string, id: string, fn: (p: Proposal) => Proposal): Promise<Proposal> {
  return withInbox(repo, async () => {
    const p = fn(structuredClone(getProposal(repo, id)));
    saveProposal(repo, p);
    return p;
  });
}

export const hold = (repo: string, id: string, now = new Date()) =>
  change(repo, id, (p) => {
    need(p.state === "open", `${p.id} is ${p.state}: only a proposed ticket is held`);
    return { ...p, state: "held", heldAt: now.toISOString() };
  });

/** Back to Proposed: a held proposal, or a removed one (Undo), to where it was. */
export const bringBack = (repo: string, id: string) =>
  change(repo, id, (p) => {
    need(p.state === "held" || p.state === "removed", `${p.id} is ${p.state}: only a held or removed ticket comes back`);
    const to = p.state === "removed" ? (p.prev ?? "open") : "open";
    const n = { ...p, state: to };
    delete n.prev;
    delete n.heldAt;
    return n;
  });

/** Removed: off every list. Its items stay in the inbox (and covered, so triage doesn't read them again). */
export const remove = (repo: string, id: string) =>
  change(repo, id, (p) => {
    need(p.state !== "run" && p.state !== "removed", `${p.id} is ${p.state === "run" ? `a job already (${p.job})` : "removed already"}`);
    return { ...p, state: "removed", prev: p.state };
  });

/** The person's words replace triage's; the items stay linked. */
export const edit = (repo: string, id: string, o: { title?: string; text?: string }) =>
  change(repo, id, (p) => {
    need(p.state === "open" || p.state === "held", `${p.id} is ${p.state}: only a proposed or held ticket is edited`);
    need(o.title?.trim() || o.text?.trim(), "--title or --text: the new words");
    return { ...p, ...(o.title?.trim() ? { title: o.title.trim().slice(0, 120) } : {}), ...(o.text?.trim() ? { text: o.text.trim() } : {}), edited: true };
  });

/** Pure: "GitHub #17", "Slack #bugs · ben", "3 reports". */
export function fromLabel(items: Item[]): string {
  if (items.length > 1) return `${items.length} reports`;
  const s = items[0]?.src;
  if (!s) return "the outer loop";
  return s.kind === "slack" && s.by ? `${s.label} · ${s.by}` : s.label;
}

/** Pure: the ticket intake reads: the proposal's text, how triage reproduced it, and the reports, quoted. */
export function ticketBody(p: Proposal, items: Item[]): string {
  const q = (t: string) =>
    t
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  const steps = p.ev?.steps?.length
    ? `How triage reproduced it${p.ev.sha ? ` (staging ${p.ev.sha})` : ""}:\n${p.ev.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "";
  const reports = items.map((i) => `${i.src.label}${i.src.by ? ` · ${i.src.by}` : ""}${i.src.url ? ` · ${i.src.url}` : ""}\n${q(i.text.slice(0, 2000))}`);
  return [p.text.trim(), steps, `Reports behind it (from the outer loop, ${p.id}):`, ...reports].filter(Boolean).join("\n\n");
}

/**
 * `kitchen inbox run`: the chosen proposals become jobs at intake, highest priority first, each through the ticket
 * path with where it came from (`from`: the source, its reference and link, the items). Returns the jobs, in order.
 */
export async function run(repo: string, ids: string[]): Promise<{ proposal: string; job: string }[]> {
  need(ids.length, "which proposals: kitchen inbox run p1 p2");
  return withInbox(repo, async () => {
    const ps = ids.map((id) => getProposal(repo, id));
    for (const p of ps) {
      need(p.state === "open", `${p.id} is ${p.state === "run" ? `a job already (${p.job})` : p.state}: only a proposed ticket runs`);
      need(p.verdict === "propose", `${p.id} is unclear: refine it with the person first (/kitchen refine)`);
    }
    const order = [...new Map(ps.map((p) => [p.id, p])).values()].sort(
      (a, b) => (a.prio ?? "P9").localeCompare(b.prio ?? "P9") || Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
    const all = listItems(repo);
    const made: { proposal: string; job: string }[] = [];
    for (const p of order) {
      const items = p.items.map((id) => all.find((i) => i.id === id)).filter((i): i is Item => !!i);
      const first = items[0];
      const refs = items.map((i) => ({ source: i.src.source, kind: i.src.kind, ref: i.src.ref, ...(i.src.url ? { url: i.src.url } : {}) }));
      const from: JobFrom = {
        source: first?.src.source ?? "inbox",
        kind: first?.src.kind ?? "inbox",
        ref: first?.src.ref ?? p.id,
        ...(first?.src.url ? { url: first.src.url } : {}),
        label: fromLabel(items),
        proposal: p.id,
        items: p.items,
        refs,
      };
      const job = await fileTicket(repo, ticketBody(p, items), { title: p.title, from });
      saveProposal(repo, { ...p, state: "run", job: job.id });
      made.push({ proposal: p.id, job: job.id });
    }
    return made;
  });
}

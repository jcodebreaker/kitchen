// What the dashboard's outer loop shows (GET /inbox.json, ADR 0022): the sources with their last collect, the collect
// running now (whoever started it), the inbox's items and proposals. Read from .kitchen/ only.
import fs from "node:fs";
import path from "node:path";
import { lastCollect, liveCollect } from "../inbox/collect.ts";
import { inboxDir, isItemId, listItems, listProposals, untriaged } from "../inbox/store.ts";
import { BUILTIN, configPath, describe, listSources, readState } from "../sources/config.ts";

export type InboxSource = {
  name: string;
  kind: string;
  label: string;
  reads: string;
  tool: string;
  skip: string;
  recipe: string | null;
  builtin: boolean;
  lastAt: string | null;
  lastNew: number;
  status: "available" | "unavailable" | null;
  error: string | null;
};

export function inboxSnapshot(repo: string) {
  const { sources } = listSources(repo);
  const src = (s: { name: string; kind: string }, builtin: boolean): InboxSource => {
    const st = readState(repo, s.name);
    const d = describe(s as Parameters<typeof describe>[0]);
    return {
      name: s.name,
      kind: s.kind,
      ...d,
      recipe: builtin ? null : configPath(s.name),
      builtin,
      lastAt: st.lastAt ?? null,
      lastNew: st.lastNew ?? 0,
      status: st.status ?? null,
      error: st.error ?? null,
    };
  };
  const items = listItems(repo);
  const proposals = listProposals(repo).filter((p) => p.state !== "removed");
  const c = liveCollect(repo);
  return {
    sources: [...sources.map((s) => src(s, false)), src({ name: BUILTIN, kind: "kitchen" }, true)],
    collect: c ? { running: true, phase: c.phase, source: c.source, step: c.step, of: c.of, text: c.text, items: c.items, at: c.at } : null,
    lastCollect: lastCollect(repo),
    items,
    fresh: c ? [] : untriaged(repo, items, listProposals(repo)).map((i) => i.id),
    proposals,
  };
}

/** An evidence file triage kept (`i-3/evidence/p2-1-shot.png`), or null when the path isn't one. */
export function evidenceFile(repo: string, rel: string): string | null {
  const m = /^(i-\d+)\/evidence\/([\w.-]+)$/.exec(rel);
  if (!m || !isItemId(m[1]) || m[2].startsWith(".")) return null;
  const f = path.join(inboxDir(repo), m[1], "evidence", m[2]);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}

// Extra views for the review lenses, any lens (PLAN §3 "UX and UI lenses"). A lens
// never drives the app: it writes `VIEW: …` lines in its review file, the engine
// runs each through the same path as `kitchen drive` (prove.ts, stamped with the
// lens's role, under the job's drive lock), and the lens is run once more with
// the new evidence. `kitchen drive <job> --view "<view>"` runs one by hand.
//
// A view is one of:
//   /settings [--as alice] [--k v]…           a page: sign in (if --as), open it, screenshot (extra args go to screenshot)
//   settings.toggle-dark [--user alice]…      a feature drive with its args, then a screenshot
//   toolkit login --as alice ; toolkit open --path /x ; …   proof segments as in a spec (a screenshot is added if none is taken)

import { withJobLock } from "../proof/job.ts";
import { parseProof, words } from "../proof/proof-line.ts";
import { prove } from "../proof/prove.ts";
import type { InstanceJob } from "./instance.ts";
import { ensureUp, freshUp, resetUp } from "./instance.ts";

/** At most this many views per lens per review: the lens is re-run once with them. */
export const MAX_VIEWS = 3;

const shq = (a: string) => (/^[\w@%+=:,./[\]-]+$/.test(a) ? a : `"${a.replace(/"/g, "")}"`);

/** Pure: a VIEW line as a proof line, or why it can't be one. `name` names its screenshot. */
export function viewProof(view: string, name: string): { proof: string } | { refused: string } {
  const v = view.trim();
  let proof: string;
  try {
    if (/^toolkit\s/.test(v)) proof = v;
    else {
      const w = words(v);
      const target = w[0] ?? "";
      const args: string[] = [];
      let as: string | undefined;
      for (let i = 1; i < w.length; i++) {
        const m = /^--([a-z][a-z0-9_]*)(?:=(.*))?$/.exec(w[i]);
        if (!m) return { refused: `${JSON.stringify(w[i])} is not --arg value` };
        const val = m[2] ?? w[++i];
        if (val === undefined) return { refused: `--${m[1]} needs a value` };
        if (m[1] === "as" && target.startsWith("/")) as = val;
        else args.push(`--${m[1]} ${shq(val)}`);
      }
      if (target.startsWith("/")) {
        if (target.startsWith("//")) return { refused: "a page is a path on the app" };
        proof = [...(as ? [`toolkit login --as ${shq(as)}`] : []), `toolkit open --path ${shq(target)}`, `toolkit screenshot --name ${name} ${args.join(" ")}`]
          .join(" ; ")
          .trim();
      } else if (/^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/.test(target)) {
        proof = `toolkit ${target} ${args.join(" ")}`.trim();
      } else return { refused: `a view is a page (/path), a feature drive (name.verb) or toolkit segments, not ${JSON.stringify(target)}` };
    }
    const segs = parseProof(proof);
    if (segs.some((s) => s.kind !== "toolkit")) return { refused: "views run toolkit segments only" };
    if (!segs.some((s) => s.kind === "toolkit" && s.name === "screenshot")) proof = `${proof} ; toolkit screenshot --name ${name}`;
    parseProof(proof);
    return { proof };
  } catch (e) {
    return { refused: (e as Error).message };
  }
}

export type ViewResult = { view: string; ok: boolean; why?: string; evidence: string[]; proof?: string };

/**
 * Run one view in the job's slot, from seed state, stamped `criterion: view:<lens>` with the
 * lens's role (no Verdict cites it: only engine and verifier entries are proof). The whole view
 * holds the job's drive lock (it resets the app): the review stage's views and `kitchen drive --view`
 * never run while another drive of the job does.
 */
export async function runView(o: {
  job: InstanceJob;
  jobDir: string;
  view: string;
  lens: string;
  n: number;
  testCmd: string;
  log?: (m: string) => void;
}): Promise<ViewResult> {
  const p = viewProof(o.view, `view-${o.lens}-${o.n}`);
  if ("refused" in p) return { view: o.view, ok: false, why: p.refused, evidence: [] };
  const proof = p.proof;
  return withJobLock(o.jobDir, async () => {
    // The app Verify left running may have died since (a wedged browser driver): one fresh start before giving up.
    await ensureUp(o.job, o.jobDir, o.log).catch(() => freshUp(o.job, o.jobDir, o.log));
    await resetUp(o.job, o.jobDir);
    const r = await prove({
      jobDir: o.jobDir,
      criterion: { id: "VIEW", proof, expect: "judged" },
      role: `reviewer-${o.lens}`,
      stampAs: `view:${o.lens}`,
      testCmd: o.testCmd,
      log: o.log,
    });
    return { view: o.view, ok: r.status === "pass", ...(r.why ? { why: r.why } : {}), evidence: r.evidence, proof };
  });
}

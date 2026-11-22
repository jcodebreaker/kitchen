// A spec criterion's `proof:` line (PLAN §2 "Spec format"), parsed. Pure.
//   toolkit <drive or primitive> [--arg value | --arg=value]… [; toolkit …]
//   cmd <shell command>
//   test <file>
// A dotted name (`settings.toggle-dark`) is a feature drive, anything else a
// primitive. Toolkit segments chain in one browser session; `cmd` and `test`
// stand alone. Values may be quoted ("…" or '…').

export type ToolkitSegment = { kind: "toolkit"; name: string; args: Record<string, string>; drive: boolean };
export type Segment = ToolkitSegment | { kind: "cmd"; cmd: string } | { kind: "test"; file: string };

export class ProofLineError extends Error {}

/** Shell-like words: spaces split, quotes group, no expansion. */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (q) throw new ProofLineError(`unclosed quote in ${JSON.stringify(s)}`);
  if (has || cur) out.push(cur);
  return out;
}

/** Split on `;` outside quotes. */
function splitSegments(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NAME = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
const ARG = /^[a-z][a-z0-9_]*$/;

export function parseProof(proof: string): Segment[] {
  const p = proof.trim();
  if (/^cmd\s/.test(p)) return [{ kind: "cmd", cmd: p.slice(3).trim() }];
  if (/^test\s/.test(p)) {
    const w = words(p.slice(4));
    if (w.length !== 1) throw new ProofLineError(`test takes one file, got ${JSON.stringify(p.slice(4).trim())}`);
    return [{ kind: "test", file: w[0] }];
  }
  if (!/^toolkit\s/.test(p)) throw new ProofLineError("a proof is `toolkit …`, `cmd …` or `test <file>`");
  return splitSegments(p).map((seg, n): ToolkitSegment => {
    // After the first segment the `toolkit` word may be left out (`toolkit login --as a ; open --path /x`).
    const w0 = words(seg);
    const w = n > 0 && w0[0] !== "toolkit" ? ["toolkit", ...w0] : w0;
    if (w[1] === "cmd" || w[1] === "test" || w[0] !== "toolkit") throw new ProofLineError(`segment ${JSON.stringify(seg)}: chain only toolkit segments with ;`);
    const name = w[1];
    if (!name || !NAME.test(name)) throw new ProofLineError(`segment ${JSON.stringify(seg)}: no drive or primitive name`);
    const args: Record<string, string> = {};
    for (let i = 2; i < w.length; i++) {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(w[i]);
      if (!m) throw new ProofLineError(`${name}: ${JSON.stringify(w[i])} is not --arg value`);
      const k = m[1];
      if (!ARG.test(k)) throw new ProofLineError(`${name}: arg name ${JSON.stringify(k)} must match [a-z][a-z0-9_]*`);
      if (k in args) throw new ProofLineError(`${name}: --${k} given twice`);
      let v = m[2];
      if (v === undefined) {
        v = w[++i];
        if (v === undefined) throw new ProofLineError(`${name}: --${k} needs a value`);
      }
      args[k] = v;
    }
    return { kind: "toolkit", name, args, drive: name.includes(".") };
  });
}

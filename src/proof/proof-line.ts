// A spec criterion's `proof:` line (PLAN §2 "Spec format"), parsed. Pure.
//   toolkit <drive or primitive> [--arg value | --arg=value]… [; toolkit …]
//   cmd <shell command>
//   test <file>
// A dotted name (`settings.toggle-dark`) is a feature drive, anything else a
// primitive. Toolkit segments chain in one browser session; `cmd` and `test`
// stand alone. Values may be quoted ("…" or '…'), as in a shell: inside "…" a
// backslash escapes `"` and `\` (as in the drive format: `--target "a[href=\"/x\"]"`),
// outside quotes it escapes any character, inside '…' it is literal (and `\"` there
// is refused: it would reach the selector as a backslash). A primitive segment may end
// with `--save <var>`: its output is kept as `$var` for later segments and the
// expect, as a drive's `save:` would (the engine's, never passed to bin/dev).

export type ToolkitSegment = { kind: "toolkit"; name: string; args: Record<string, string>; drive: boolean; save?: string };
export type Segment = ToolkitSegment | { kind: "cmd"; cmd: string } | { kind: "test"; file: string };

export class ProofLineError extends Error {}

/** What a spec writes when it means a quote inside a value. */
const QUOTING =
  'inside \'…\' a backslash is kept as is, so \\" reaches the Toolkit with its backslash: write the value in "…" with \\" for an inner quote (--target "a[href=\\"/x\\"]"), or in \'…\' with plain " inside (--target \'a[href="/x"]\')';

/**
 * Shell-like words: spaces split, quotes group, no expansion. Backslash: inside "…" it escapes `"` and `\`,
 * outside quotes any character, inside '…' nothing. `strict`: refuse `\"` inside '…' (a proof value meant a quote).
 */
export function words(s: string, strict = false): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  const cs = [...s];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (q === '"' && c === "\\" && (cs[i + 1] === '"' || cs[i + 1] === "\\")) cur += cs[++i];
    else if (q === "'" && strict && c === "\\" && cs[i + 1] === '"') throw new ProofLineError(`${JSON.stringify(s)}: ${QUOTING}`);
    else if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === "\\" && i + 1 < cs.length) {
      cur += cs[++i];
      has = true;
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

/** Split on `;` outside quotes (an escaped quote or `;` doesn't count; the escape stays for words()). */
function splitSegments(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  const cs = [...s];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === "\\" && q !== "'" && i + 1 < cs.length) {
      cur += c + cs[++i];
      continue;
    }
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
    const w0 = words(seg, true);
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
    const drive = name.includes(".");
    if (!("save" in args)) return { kind: "toolkit", name, args, drive };
    // Review run: a spec wrote `read --target x --save owner`, which bin/dev got as an arg and no var was kept.
    if (drive) throw new ProofLineError(`${name}: --save is for one primitive; a feature drive saves its own vars (save: in the drive)`);
    const { save, ...rest } = args;
    if (!/^[a-z_][a-z0-9_]*$/i.test(save)) throw new ProofLineError(`${name}: --save takes a var name, got ${JSON.stringify(save)}`);
    return { kind: "toolkit", name, args: rest, drive, save };
  });
}

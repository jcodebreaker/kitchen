// The questions `kitchen init` and `kitchen toolkit build` ask (ADR 0011): the recommended
// answer is shown first and Enter takes it. Yes/no is `[Y/n]` (or `[y/N]` when no is the
// recommendation), a choice is a numbered list with the recommended one marked, and a free
// answer shows its default. `--yes` takes every recommended answer, for CI. One exception:
// a question about text an agent wrote (checks it proposed) is `[y/N]`, and `--yes` never
// says yes to it (ADR 0010, review R8): untrusted text never gets a yes by default.
//
// Ctrl-C or Ctrl-D at a prompt is a halt, not an answer: the caller prints the command that
// resumes. Without a terminal and without --yes nobody can answer: each method returns
// undefined and the caller decides (write the questions to a file, keep the safe default).
import readline from "node:readline/promises";

/** The person stopped at a prompt (Ctrl-C, Ctrl-D). */
export class Halt extends Error {
  constructor() {
    super("stopped at a question");
  }
}

export type Choice<T extends string> = { value: T; label: string };

export type Ask = {
  /** A person can answer: a terminal, or --yes answering for them. */
  readonly canAnswer: boolean;
  readonly yes: boolean;
  yesNo(q: string, o: { recommended: boolean; untrusted?: boolean }): Promise<boolean | undefined>;
  choose<T extends string>(q: string, options: Choice<T>[], recommended: number): Promise<T | undefined>;
  text(q: string, o: { default: string; why?: string; heading?: string }): Promise<string | undefined>;
};

/** Pure: `[Y/n]` or `[y/N]`, the capital is what Enter takes. */
export const yesNoHint = (recommended: boolean) => (recommended ? "[Y/n]" : "[y/N]");

/** Pure: an answer to a yes/no question; Enter is the recommended one; anything else is asked again (undefined). */
export function parseYesNo(a: string, recommended: boolean): boolean | undefined {
  const t = a.trim().toLowerCase();
  if (!t) return recommended;
  if (t === "y" || t === "yes") return true;
  if (t === "n" || t === "no") return false;
  return undefined;
}

/** Pure: the numbered list, the recommended one first in the prompt and marked. */
export function choiceLines<T extends string>(q: string, options: Choice<T>[], recommended: number): string[] {
  return [q, ...options.map((o, i) => `  ${i + 1}) ${o.label}${i === recommended ? "   (recommended)" : ""}`)];
}

/** Pure: a number, or the option's value; Enter is the recommended one; anything else is asked again (undefined). */
export function parseChoice<T extends string>(a: string, options: Choice<T>[], recommended: number): number | undefined {
  const t = a.trim().toLowerCase();
  if (!t) return recommended;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  const i = options.findIndex((o) => o.value.toLowerCase() === t);
  return i >= 0 ? i : undefined;
}

/** Nobody to ask: a script, an agent's shell, CI without --yes. */
export const noOneToAsk: Ask = {
  canAnswer: false,
  yes: false,
  yesNo: async () => undefined,
  choose: async () => undefined,
  text: async () => undefined,
};

/** --yes: every recommended answer, said out loud; never a yes to untrusted text. */
export function yesToAll(out: (l: string) => void): Ask {
  return {
    canAnswer: true,
    yes: true,
    yesNo: async (q, o) => {
      if (o.untrusted) {
        out(`${q} ${yesNoHint(false)} no (--yes never accepts what an agent proposed)`);
        return false;
      }
      out(`${q} ${yesNoHint(o.recommended)} ${o.recommended ? "yes" : "no"} (--yes)`);
      return o.recommended;
    },
    choose: async (q, options, rec) => {
      out(`${q} ${options[rec].label} (--yes)`);
      return options[rec].value;
    },
    text: async (q, o) => {
      out(`${q} ${o.default || "(no answer)"} (--yes)`);
      return o.default;
    },
  };
}

export type Io = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };

/** Questions in a terminal. Each `question` call is one line of input; Ctrl-C or Ctrl-D throws Halt. */
export function terminalAsk(io: Io = { input: process.stdin, output: process.stdout }): Ask {
  const line = async (prompt: string): Promise<string> => {
    const rl = readline.createInterface({ input: io.input, output: io.output, terminal: (io.output as { isTTY?: boolean }).isTTY === true });
    const ac = new AbortController();
    rl.on("SIGINT", () => ac.abort());
    rl.on("close", () => ac.abort());
    try {
      return await rl.question(prompt, { signal: ac.signal });
    } catch {
      throw new Halt();
    } finally {
      rl.close();
    }
  };
  const say = (l: string) => io.output.write(`${l}\n`);
  return {
    canAnswer: true,
    yes: false,
    yesNo: async (q, o) => {
      // Untrusted text: no is the recommendation, whatever the caller said.
      const rec = o.untrusted ? false : o.recommended;
      for (;;) {
        const v = parseYesNo(await line(`${q} ${yesNoHint(rec)} `), rec);
        if (v !== undefined) return v;
        say("  Please answer y or n (Enter takes the capital one).");
      }
    },
    choose: async (q, options, rec) => {
      for (const l of choiceLines(q, options, rec)) say(l);
      for (;;) {
        const i = parseChoice(await line(`Choose 1-${options.length} [${rec + 1}]: `), options, rec);
        if (i !== undefined) return options[i].value;
        say(`  Please type a number from 1 to ${options.length}.`);
      }
    },
    text: async (q, o) => {
      if (o.heading) say(o.heading);
      say(`  ${q}`);
      if (o.why) say(`  (${o.why})`);
      const a = (await line(o.default ? `  Enter = ${o.default} (recommended), or type your answer: ` : "  Your answer: ")).trim();
      return a || o.default;
    },
  };
}

/** The Ask for this run: --yes, else a terminal if there is one, else nobody. */
export function askFor(o: { yes?: boolean; out: (l: string) => void; tty?: boolean }): Ask {
  if (o.yes) return yesToAll(o.out);
  const tty = o.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  return tty ? terminalAsk() : noOneToAsk;
}

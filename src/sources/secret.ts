// The Slack bot token (ADR 0022, amendment): kept where `gh` keeps its own, the OS keychain, never in the repo.
// macOS: `security` (login keychain, service kitchen-slack); Linux: `secret-tool` (libsecret). KITCHEN_SLACK_TOKEN,
// when set, wins: for a machine without a keychain, and for tests, which never touch the real one.
import { execFileSync } from "node:child_process";

export const SERVICE = "kitchen-slack";
export const ACCOUNT = "default";
type Run = (cmd: string, args: string[], input?: string) => string;
const realRun: Run = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], timeout: 10_000 });

/** The token, or null when none is stored. */
export function slackToken(o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: Run } = {}): string | null {
  const env = o.env ?? process.env;
  if (env.KITCHEN_SLACK_TOKEN?.trim()) return env.KITCHEN_SLACK_TOKEN.trim();
  const run = o.run ?? realRun;
  const platform = o.platform ?? process.platform;
  try {
    if (platform === "darwin") return run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).trim() || null;
    if (platform === "linux") return run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]).trim() || null;
  } catch {}
  return null;
}

/** Store (or replace) the token in the keychain. Returns where it went. */
export function storeSlackToken(token: string, o: { platform?: NodeJS.Platform; run?: Run } = {}): string {
  const t = token.trim();
  if (!/^xox[bp]-[A-Za-z0-9-]+$/.test(t)) throw new Error("that isn't a Slack token (a bot token starts with xoxb-)");
  const run = o.run ?? realRun;
  const platform = o.platform ?? process.platform;
  if (platform === "darwin") {
    run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-l", "Kitchen Slack app", "-w", t]);
    return "the macOS keychain (kitchen-slack)";
  }
  if (platform === "linux") {
    run("secret-tool", ["store", "--label=Kitchen Slack app", "service", SERVICE, "account", ACCOUNT], t);
    return "the keyring, through secret-tool (kitchen-slack)";
  }
  throw new Error("no keychain Kitchen knows on this system: set KITCHEN_SLACK_TOKEN in the environment kitchen collect runs in");
}

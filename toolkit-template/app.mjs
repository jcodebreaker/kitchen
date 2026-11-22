// The project-specific half of this Toolkit. bin/dev (generic, contract v1)
// calls these; everything here is about THIS app. Replace every TODO with what
// the repo actually does — no placeholders may survive setup.
//
// ctx (from bin/dev): { id, src, ports, state, env (.env.kitchen), stateDir, out (primitives),
//   log, run, must, appEnv, waitFor, httpJson, save(),
//   spawn(name, cmd, args, {cwd, env}) → pid (own process group, killed by down),
//   container(name, dockerRunArgs) → name (labelled, removed by down),
//   compose(args, {files, cwd, env}) (project per id, `down -v` by down) }
// Anything started through spawn/container/compose is torn down by `down` even
// if app.down forgets it. Never kill by process name.

export default {
  /** Short, lowercase: names state dirs, containers and labels. */
  name: "TODO-app",
  /** web | cli | api. A web Toolkit must offer the generic primitives (lib/browser.mjs). */
  surface: "TODO",
  /** How many of the slot's ports `up` uses, in order. The engine gives each slot 20. */
  ports: { needs: 1, order: ["app"] },
  /** false only if two instances truly can't run side by side (then Kitchen runs one job at a time). */
  parallel: true,
  /** External services the app calls, each replaced by a local mock or a sandbox: [{ name: "stripe", mode: "mock" }]. */
  externals: [],

  /** Seed usernames drives sign in as: plain strings, e.g. ["alice", "bob-admin"] (passwords stay in .env.kitchen). Read them from the seed, don't hand-keep them. */
  async seedUsers(_ctx) {
    return [];
  },

  /** Make --src runnable: deps with a shared cache, Toolkit deps, build, seed snapshot. Idempotent and cached. Return extra fields for the JSON line. */
  async prepare(_ctx) {
    // TODO
    return {};
  },

  /** From an empty data dir through migrations and seed to a usable app on ctx.ports. Throw on failure (bin/dev cleans up). Return { url }. */
  async up(_ctx) {
    // TODO
    throw new Error("up: not written yet");
  },

  /** Read-only checks: name → () => true | "why not". Process liveness of everything ctx.spawn started is added by bin/dev. */
  doctor(_ctx) {
    return {
      // "app answers on its port": async () => (await ctx.httpJson(`${ctx.state.url}/health`)).status === 200 || "no answer",
    };
  },

  /** Back to seed state (data and sessions) without a full restart. */
  async reset(_ctx) {
    // TODO
  },

  /** Stop what this id started that bin/dev can't see (spawn/container/compose are handled already). */
  async down(_ctx) {},

  /** Primitives a feature drive may call: name → { args: {name: "what"}, does, run(ctx, args) → { ok, out, files? } }. Files go in ctx.out only. */
  primitives: {},
};

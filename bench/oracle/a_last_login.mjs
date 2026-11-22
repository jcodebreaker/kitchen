// Hidden oracle (bench) for a-primitive: after the oracle's C1 signed alice in and
// refused bob-admin a wrong password, both through the real sign-in page, alice's
// users.last_login_at is set (within the last 15 minutes) and bob-admin's is still NULL.
// Reads the oracle app's own Postgres over loopback: the port is the slot's (the bench
// fills `{port:1}`), the credentials are the fixture's fake ones in .env.kitchen.
//   node oracle_last_login.mjs <postgres port>
import fs from "node:fs";
import pg from "pg";

const port = Number(process.argv[2]);
if (!port) {
  console.log("usage: node oracle_last_login.mjs <postgres port>");
  process.exit(2);
}
const env = Object.fromEntries(
  fs
    .readFileSync(".env.kitchen", "utf8")
    .split("\n")
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const db = new pg.Client({ host: "127.0.0.1", port, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: env.POSTGRES_DB });
await db.connect();
try {
  const { rows } = await db.query(
    "SELECT username, last_login_at, now() - last_login_at < interval '15 minutes' AS recent FROM users WHERE username IN ('alice', 'bob-admin') ORDER BY username",
  );
  const by = Object.fromEntries(rows.map((r) => [r.username, r]));
  console.log(JSON.stringify(rows));
  const problems = [
    ...(by.alice?.last_login_at ? [] : ["alice signed in, but her last_login_at is NULL"]),
    ...(by.alice?.last_login_at && !by.alice.recent ? ["alice's last_login_at is not the time of this sign-in"] : []),
    ...(by["bob-admin"] && by["bob-admin"].last_login_at === null ? [] : ["bob-admin's sign-in was refused, but his last_login_at is set"]),
  ];
  for (const p of problems) console.log(p);
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  console.log(`query failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

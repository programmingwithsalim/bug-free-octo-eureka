// One-time setup: creates the database + tables and writes .env.local (git-ignored) with the connection string.
//   npm run db:setup -- --password <your postgres password>
// Other flags: --user postgres --host localhost --port 5432 --db trade_journal --force
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : a), []));
const cfg = { user: args.user ?? "postgres", password: args.password ?? process.env.PGPASSWORD, host: args.host ?? "localhost", port: Number(args.port ?? 5432), db: args.db ?? "trade_journal" };
if (!cfg.password || cfg.password === true) {
  console.error("Missing password. Run: npm run db:setup -- --password <your postgres password>");
  process.exit(1);
}

const admin = new pg.Client({ user: cfg.user, password: cfg.password, host: cfg.host, port: cfg.port, database: "postgres" });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [cfg.db]);
if (!exists.rowCount) {
  await admin.query(`CREATE DATABASE "${cfg.db.replace(/"/g, "")}"`);
  console.log(`Created database ${cfg.db}`);
} else console.log(`Database ${cfg.db} already exists`);
await admin.end();

const db = new pg.Client({ user: cfg.user, password: cfg.password, host: cfg.host, port: cfg.port, database: cfg.db });
await db.connect();
await db.query(fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8"));
await db.end();
console.log("Tables ready");

const envFile = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envFile) && !args.force && /DATABASE_URL=/.test(fs.readFileSync(envFile, "utf8"))) {
  console.log(".env.local already has DATABASE_URL (use --force to overwrite)");
} else {
  const url = `postgres://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${cfg.db}`;
  fs.writeFileSync(envFile, `DATABASE_URL=${url}\n`);
  console.log("Wrote .env.local (git-ignored). Restart `npm run dev`.");
}

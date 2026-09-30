import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface Db {
  kind: "postgres" | "pglite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.split("\n").every((line) => line.trim().startsWith("--") || line.trim() === ""));
}

export async function openDatabase(config: AppConfig): Promise<Db> {
  if (config.databaseUrl) return openPostgres(config.databaseUrl);
  if (!config.allowPglite) throw new Error("PGlite disabled");
  const { PGlite } = await import("@electric-sql/pglite");
  const file = process.env.DM_PGLITE_PATH;
  if (file) mkdirSync(file, { recursive: true });
  const client = file ? new PGlite(file) : new PGlite();
  return {
    kind: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return result.rows;
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
    async close() {
      await client.close();
    },
  };
}

function openPostgres(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    kind: "postgres",
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
    async exec(sql: string) {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export async function migrate(db: Db): Promise<void> {
  const dir = join(here, "../migrations");
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at bigint NOT NULL)`);
  for (const file of files) {
    const applied = await db.query<{ id: string }>("SELECT id FROM schema_migrations WHERE id = $1", [file]);
    if (applied.length > 0) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    if (db.kind === "pglite") await db.exec(sql);
    else {
      for (const statement of splitSql(sql)) await db.exec(statement);
    }
    await db.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [file, Date.now()]);
  }
}

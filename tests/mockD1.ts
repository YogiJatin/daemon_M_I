import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createMockD1(): any {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  // Execute all migrations in order
  const migrationsDir = path.join(__dirname, "../migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      sqlite.exec(sql);
    } catch (_err) {
      const statements = sql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        try { sqlite.exec(stmt + ";"); } catch (_) {}
      }
    }
  }

  // Serializing write queue — prevents audit sequence_number race conditions
  // All writes go through this queue to simulate D1's atomic batch behavior.
  let _queue: Promise<any> = Promise.resolve();

  function serialWrite<T>(fn: () => T): Promise<T> {
    const p = _queue.then(fn);
    _queue = p.catch(() => {});
    return p;
  }

  // Wrapper around a prepared statement with bound params
  function wrapStatement(query: string, boundParams: any[] = []) {
    const wrapper = {
      _query: query,
      _params: boundParams,

      bind(...params: any[]) {
        return wrapStatement(query, params);
      },

      async first<T = any>(colName?: string): Promise<T | null> {
        return serialWrite(() => {
          const stmt = sqlite.prepare(query);
          const row = stmt.get(...boundParams) as any;
          if (!row) return null;
          if (colName) return (row as any)[colName];
          return row as T;
        });
      },

      async all<T = any>(): Promise<{ results: T[] }> {
        return serialWrite(() => {
          const stmt = sqlite.prepare(query);
          const rows = stmt.all(...boundParams) as T[];
          return { results: rows };
        });
      },

      async run(): Promise<{ success: boolean }> {
        return serialWrite(() => {
          const stmt = sqlite.prepare(query);
          stmt.run(...boundParams);
          return { success: true };
        });
      },
    };
    return wrapper;
  }

  const d1 = {
    prepare(query: string) {
      return wrapStatement(query);
    },

    /**
     * Executes statements as a true atomic batch (within a single serialized write slot).
     * This is critical for audit_chain sequence_number correctness.
     */
    async batch(statements: any[]): Promise<any[]> {
      return serialWrite(() => {
        const results: any[] = [];
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          for (const s of statements) {
            const stmt = sqlite.prepare(s._query);
            const info = stmt.run(...s._params) as any;
            results.push({
              success: true,
              meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
            });
          }
          sqlite.exec("COMMIT");
        } catch (e) {
          try { sqlite.exec("ROLLBACK"); } catch (_) {}
          throw e;
        }
        return results;
      });
    },

    async exec(query: string) {
      sqlite.exec(query);
    },

    _rawSqlite: sqlite,
  };

  return d1;
}

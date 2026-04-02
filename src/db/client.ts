import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;
let _pool: pg.Pool | undefined;

export function createDb(connectionString: string) {
  if (_db) return _db;

  _pool = new pg.Pool({ connectionString });
  _db = drizzle(_pool, { schema });
  return _db;
}

export function getDb() {
  if (!_db) {
    throw new Error("Database not initialized. Call createDb() first.");
  }
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}

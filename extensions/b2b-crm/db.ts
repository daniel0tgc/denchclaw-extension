import { Database, Connection } from 'duckdb-async';

const instances = new Map<string, Database>();

export async function getDb(dbPath: string = 'workspace.duckdb'): Promise<Database> {
  let db = instances.get(dbPath);
  if (!db) {
    db = await Database.create(dbPath);
    instances.set(dbPath, db);
  }
  return db;
}

export async function getConnection(dbPath?: string): Promise<Connection> {
  const database = await getDb(dbPath);
  return database.connect();
}

export async function runQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  dbPath?: string
): Promise<T[]> {
  const conn = await getConnection(dbPath);
  try {
    return await conn.all(sql, ...params) as T[];
  } finally {
    await conn.close();
  }
}

export async function execQuery(
  sql: string,
  params: unknown[] = [],
  dbPath?: string
): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    await conn.exec(sql, ...params);
  } finally {
    await conn.close();
  }
}

export async function closeDb(dbPath?: string): Promise<void> {
  if (dbPath) {
    const db = instances.get(dbPath);
    if (db) {
      await db.close();
      instances.delete(dbPath);
    }
  } else {
    for (const [path, db] of instances) {
      await db.close();
      instances.delete(path);
    }
  }
}

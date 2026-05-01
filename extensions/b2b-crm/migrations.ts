import { execQuery, runQuery } from './db.js';

interface Migration {
  version: number;
  name: string;
  up: string;
}

export async function runMigrations(migrations: Migration[]): Promise<void> {
  await execQuery(`
    CREATE TABLE IF NOT EXISTS b2b_crm_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = await runQuery<{ version: number }>(
    'SELECT version FROM b2b_crm_migrations ORDER BY version'
  );
  const appliedVersions = new Set(applied.map(r => r.version));

  for (const migration of migrations.sort((a, b) => a.version - b.version)) {
    if (appliedVersions.has(migration.version)) continue;

    await execQuery(migration.up);
    await execQuery(
      'INSERT INTO b2b_crm_migrations (version, name) VALUES (?, ?)',
      [migration.version, migration.name]
    );
  }
}

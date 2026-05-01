import { getConnection } from './db.js';

export interface TenantContext {
  tenantId: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
}

/**
 * Injects `tenant_id = ?` into a SQL query's WHERE clause.
 * If a WHERE clause exists, prepends the tenant condition.
 * If no WHERE clause, inserts one before ORDER BY / GROUP BY / LIMIT / HAVING / OFFSET or at end.
 * The tenant parameter is always placed first in the returned params array.
 */
function injectTenantCondition(
  sql: string,
  params: unknown[],
  tenantId: string,
): { sql: string; params: unknown[] } {
  const whereRegex = /\bWHERE\b/i;

  if (whereRegex.test(sql)) {
    // Prepend tenant condition right after WHERE, wrapping the rest in parens
    const injected = sql.replace(whereRegex, 'WHERE tenant_id = ? AND (') + ')';
    return { sql: injected, params: [tenantId, ...params] };
  }

  // No WHERE — insert before any clause terminator or at end of statement
  const terminatorRegex = /(\s+)(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET)\b/i;
  const match = terminatorRegex.exec(sql);
  if (match?.index !== undefined) {
    const injected =
      sql.slice(0, match.index) + ' WHERE tenant_id = ?' + sql.slice(match.index);
    return { sql: injected, params: [tenantId, ...params] };
  }

  return { sql: `${sql} WHERE tenant_id = ?`, params: [tenantId, ...params] };
}

/**
 * Creates a TenantContext that scopes all queries to the given tenantId.
 * Tables queried through this context must have a `tenant_id VARCHAR` column.
 */
export function createTenantContext(tenantId: string, dbPath?: string): TenantContext {
  return {
    tenantId,

    async query<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const { sql: injected, params: injectedParams } = injectTenantCondition(
        sql,
        params,
        tenantId,
      );
      const conn = await getConnection(dbPath);
      try {
        return (await conn.all(injected, ...injectedParams)) as T[];
      } finally {
        await conn.close();
      }
    },

    async exec(sql: string, params: unknown[] = []): Promise<void> {
      const { sql: injected, params: injectedParams } = injectTenantCondition(
        sql,
        params,
        tenantId,
      );
      const conn = await getConnection(dbPath);
      try {
        await conn.run(injected, ...injectedParams);
      } finally {
        await conn.close();
      }
    },
  };
}

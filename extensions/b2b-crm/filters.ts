export interface FilterClause {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'not_in';
  value: string | number | string[];
}

export interface FilterGroup {
  logic: 'AND' | 'OR';
  clauses: Array<FilterClause | FilterGroup>;
}

type BuildResult = { sql: string; params: unknown[] };

const OPERATOR_MAP: Record<FilterClause['operator'], string> = {
  eq:      '=',
  neq:     '!=',
  gt:      '>',
  gte:     '>=',
  lt:      '<',
  lte:     '<=',
  like:    'LIKE',
  ilike:   'ILIKE',
  in:      'IN',
  not_in:  'NOT IN',
};

function isFilterGroup(node: FilterClause | FilterGroup): node is FilterGroup {
  return 'logic' in node && 'clauses' in node;
}

/**
 * Recursively builds a parameterized WHERE condition from a filter node.
 * Returns { sql, params } where sql is a parenthesized expression.
 */
function buildCondition(node: FilterClause | FilterGroup): BuildResult {
  if (isFilterGroup(node)) {
    if (node.clauses.length === 0) return { sql: '1=1', params: [] };

    const parts: string[] = [];
    const params: unknown[] = [];
    for (const clause of node.clauses) {
      const child = buildCondition(clause);
      parts.push(child.sql);
      params.push(...child.params);
    }
    return { sql: `(${parts.join(` ${node.logic} `)})`, params };
  }

  // FilterClause
  const op = OPERATOR_MAP[node.operator];
  // Field names may contain spaces — double-quote them in SQL
  const quotedField = `"${node.field.replace(/"/g, '""')}"`;

  if (node.operator === 'in' || node.operator === 'not_in') {
    const values = Array.isArray(node.value) ? node.value : [node.value as string];
    const placeholders = values.map(() => '?').join(', ');
    return { sql: `${quotedField} ${op} (${placeholders})`, params: values };
  }

  // PIVOT view fields are stored as VARCHAR. For numeric comparison operators,
  // cast the field to NUMERIC so that 1000 > 500 instead of '1' > '5'.
  const numericOps = new Set(['gt', 'gte', 'lt', 'lte']);
  if (numericOps.has(node.operator) && typeof node.value === 'number') {
    return { sql: `${quotedField}::NUMERIC ${op} ?`, params: [node.value] };
  }

  return { sql: `${quotedField} ${op} ?`, params: [node.value] };
}

/**
 * Builds a fully parameterized SELECT query from a FilterGroup against a named view.
 *
 * Example:
 *   buildFilterSQL({ logic: 'AND', clauses: [
 *     { field: 'Industry', operator: 'eq', value: 'Manufacturing' },
 *     { field: 'Employee Count', operator: 'gt', value: 500 },
 *   ]}, 'v_account')
 *   → { sql: 'SELECT * FROM v_account WHERE ("Industry" = ? AND "Employee Count" > ?)', params: ['Manufacturing', 500] }
 */
export function buildFilterSQL(filter: FilterGroup, viewName: string): BuildResult {
  const { sql: condition, params } = buildCondition(filter);
  return {
    sql: `SELECT * FROM ${viewName} WHERE ${condition}`,
    params,
  };
}

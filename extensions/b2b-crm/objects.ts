import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection } from './db.js';

const ACCOUNT_OBJECT_YAML = `\
name: "account"
description: "B2B company account"
icon: "building"
default_view: "table"
entry_count: 0
fields:
  - name: "Company Name"
    type: text
    required: true
  - name: "Domain"
    type: url
  - name: "Industry"
    type: enum
    values: ["Manufacturing", "Energy", "Chemicals", "Mining", "Agriculture", "Construction", "Logistics", "Other"]
  - name: "Employee Count"
    type: number
  - name: "Annual Revenue"
    type: number
  - name: "HQ City"
    type: text
  - name: "HQ Country"
    type: text
  - name: "Owner"
    type: user
  - name: "Phone"
    type: phone
  - name: "Website"
    type: url
  - name: "Description"
    type: richtext
  - name: "Tags"
    type: tags
`;

const CONTACT_OBJECT_YAML = `\
name: "contact"
description: "Person at a B2B account"
icon: "user"
default_view: "table"
entry_count: 0
fields:
  - name: "First Name"
    type: text
    required: true
  - name: "Last Name"
    type: text
    required: true
  - name: "Email Address"
    type: email
    required: true
  - name: "Phone Number"
    type: phone
  - name: "Job Title"
    type: text
  - name: "Department"
    type: text
  - name: "Account"
    type: relation
    related_object: account
    relationship_type: many_to_one
  - name: "LinkedIn URL"
    type: url
  - name: "Notes"
    type: richtext
  - name: "Tags"
    type: tags
`;

const DEAL_OBJECT_YAML = `\
name: "deal"
description: "Sales opportunity"
icon: "handshake"
default_view: "kanban"
entry_count: 0
fields:
  - name: "Deal Name"
    type: text
    required: true
  - name: "Account"
    type: relation
    related_object: account
    relationship_type: many_to_one
  - name: "Deal Value"
    type: number
  - name: "Currency"
    type: enum
    values: ["USD", "EUR", "GBP", "JPY"]
  - name: "Expected Close"
    type: date
  - name: "Owner"
    type: user
  - name: "Lead Source"
    type: enum
    values: ["Inbound", "Outbound", "Referral", "Partner", "Event"]
  - name: "Probability"
    type: number
  - name: "Description"
    type: richtext
  - name: "Tags"
    type: tags
`;

/**
 * Inserts account, contact, and deal EAV objects into DuckDB.
 * Idempotent — uses ON CONFLICT DO NOTHING on all inserts.
 * Wraps all inserts in a single transaction.
 */
export async function createObjects(dbPath?: string): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    await conn.exec('BEGIN TRANSACTION');

    // --- objects ---
    await conn.run(
      `INSERT INTO objects (name, description) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`,
      'account', 'B2B company account'
    );
    await conn.run(
      `INSERT INTO objects (name, description) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`,
      'contact', 'Person at a B2B account'
    );
    await conn.run(
      `INSERT INTO objects (name, description) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`,
      'deal', 'Sales opportunity'
    );

    // --- account fields ---
    const accountFields: Array<[string, string, number, boolean, string | null, string | null, string | null]> = [
      ['Company Name', 'text',     1,  true,  null, null, null],
      ['Domain',       'url',      2,  false, null, null, null],
      ['Industry',     'enum',     3,  false, null, null, JSON.stringify(['Manufacturing','Energy','Chemicals','Mining','Agriculture','Construction','Logistics','Other'])],
      ['Employee Count','number',  4,  false, null, null, null],
      ['Annual Revenue','number',  5,  false, null, null, null],
      ['HQ City',      'text',     6,  false, null, null, null],
      ['HQ Country',   'text',     7,  false, null, null, null],
      ['Owner',        'user',     8,  false, null, null, null],
      ['Phone',        'phone',    9,  false, null, null, null],
      ['Website',      'url',      10, false, null, null, null],
      ['Description',  'richtext', 11, false, null, null, null],
      ['Tags',         'tags',     12, false, null, null, null],
    ];
    for (const [name, type, sort_order, required, related_object_id, relationship_type, enum_values] of accountFields) {
      await conn.run(
        `INSERT INTO fields (object_id, name, type, sort_order, required, related_object_id, relationship_type, enum_values)
         VALUES ((SELECT id FROM objects WHERE name = 'account'), ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (object_id, name) DO NOTHING`,
        name, type, sort_order, required, related_object_id, relationship_type, enum_values
      );
    }

    // --- account statuses ---
    const accountStatuses: Array<[string, string, number, boolean]> = [
      ['prospect', '#3b82f6', 1, true],
      ['active',   '#22c55e', 2, false],
      ['churned',  '#ef4444', 3, false],
    ];
    for (const [name, color, sort_order, is_default] of accountStatuses) {
      await conn.run(
        `INSERT INTO statuses (object_id, name, color, sort_order, is_default)
         VALUES ((SELECT id FROM objects WHERE name = 'account'), ?, ?, ?, ?)
         ON CONFLICT (object_id, name) DO NOTHING`,
        name, color, sort_order, is_default
      );
    }

    // --- contact fields ---
    const contactFields: Array<[string, string, number, boolean, string | null, string | null, string | null]> = [
      ['First Name',    'text',     1,  true,  null,      null,           null],
      ['Last Name',     'text',     2,  true,  null,      null,           null],
      ['Email Address', 'email',    3,  true,  null,      null,           null],
      ['Phone Number',  'phone',    4,  false, null,      null,           null],
      ['Job Title',     'text',     5,  false, null,      null,           null],
      ['Department',    'text',     6,  false, null,      null,           null],
      ['Account',       'relation', 7,  false, 'account', 'many_to_one',  null],
      ['LinkedIn URL',  'url',      8,  false, null,      null,           null],
      ['Notes',         'richtext', 9,  false, null,      null,           null],
      ['Tags',          'tags',     10, false, null,      null,           null],
    ];
    for (const [name, type, sort_order, required, related_object, relationship_type, enum_values] of contactFields) {
      if (related_object) {
        await conn.run(
          `INSERT INTO fields (object_id, name, type, sort_order, required, related_object_id, relationship_type, enum_values)
           VALUES (
             (SELECT id FROM objects WHERE name = 'contact'),
             ?, ?, ?, ?,
             (SELECT id FROM objects WHERE name = ?),
             ?, ?
           ) ON CONFLICT (object_id, name) DO NOTHING`,
          name, type, sort_order, required, related_object, relationship_type, enum_values
        );
      } else {
        await conn.run(
          `INSERT INTO fields (object_id, name, type, sort_order, required, related_object_id, relationship_type, enum_values)
           VALUES ((SELECT id FROM objects WHERE name = 'contact'), ?, ?, ?, ?, NULL, NULL, ?)
           ON CONFLICT (object_id, name) DO NOTHING`,
          name, type, sort_order, required, enum_values
        );
      }
    }

    // --- contact statuses ---
    const contactStatuses: Array<[string, string, number, boolean]> = [
      ['active',   '#22c55e', 1, true],
      ['inactive', '#94a3b8', 2, false],
    ];
    for (const [name, color, sort_order, is_default] of contactStatuses) {
      await conn.run(
        `INSERT INTO statuses (object_id, name, color, sort_order, is_default)
         VALUES ((SELECT id FROM objects WHERE name = 'contact'), ?, ?, ?, ?)
         ON CONFLICT (object_id, name) DO NOTHING`,
        name, color, sort_order, is_default
      );
    }

    // --- deal fields ---
    const dealFields: Array<[string, string, number, boolean, string | null, string | null, string | null]> = [
      ['Deal Name',      'text',     1,  true,  null,      null,          null],
      ['Account',        'relation', 2,  true,  'account', 'many_to_one', null],
      ['Deal Value',     'number',   3,  false, null,      null,          null],
      ['Currency',       'enum',     4,  false, null,      null,          JSON.stringify(['USD','EUR','GBP','JPY'])],
      ['Expected Close', 'date',     5,  false, null,      null,          null],
      ['Owner',          'user',     6,  false, null,      null,          null],
      ['Lead Source',    'enum',     7,  false, null,      null,          JSON.stringify(['Inbound','Outbound','Referral','Partner','Event'])],
      ['Probability',    'number',   8,  false, null,      null,          null],
      ['Description',    'richtext', 9,  false, null,      null,          null],
      ['Tags',           'tags',     10, false, null,      null,          null],
    ];
    for (const [name, type, sort_order, required, related_object, relationship_type, enum_values] of dealFields) {
      if (related_object) {
        await conn.run(
          `INSERT INTO fields (object_id, name, type, sort_order, required, related_object_id, relationship_type, enum_values)
           VALUES (
             (SELECT id FROM objects WHERE name = 'deal'),
             ?, ?, ?, ?,
             (SELECT id FROM objects WHERE name = ?),
             ?, ?
           ) ON CONFLICT (object_id, name) DO NOTHING`,
          name, type, sort_order, required, related_object, relationship_type, enum_values
        );
      } else {
        await conn.run(
          `INSERT INTO fields (object_id, name, type, sort_order, required, related_object_id, relationship_type, enum_values)
           VALUES ((SELECT id FROM objects WHERE name = 'deal'), ?, ?, ?, ?, NULL, NULL, ?)
           ON CONFLICT (object_id, name) DO NOTHING`,
          name, type, sort_order, required, enum_values
        );
      }
    }

    // --- deal pipeline statuses ---
    const dealStatuses: Array<[string, string, number, boolean]> = [
      ['prospecting', '#94a3b8', 1, true],
      ['qualified',   '#3b82f6', 2, false],
      ['proposal',    '#f59e0b', 3, false],
      ['negotiation', '#f97316', 4, false],
      ['won',         '#22c55e', 5, false],
      ['lost',        '#ef4444', 6, false],
    ];
    for (const [name, color, sort_order, is_default] of dealStatuses) {
      await conn.run(
        `INSERT INTO statuses (object_id, name, color, sort_order, is_default)
         VALUES ((SELECT id FROM objects WHERE name = 'deal'), ?, ?, ?, ?)
         ON CONFLICT (object_id, name) DO NOTHING`,
        name, color, sort_order, is_default
      );
    }

    await conn.exec('COMMIT');
  } catch (err) {
    await conn.exec('ROLLBACK');
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Creates or replaces v_account, v_contact, v_deal PIVOT views.
 * Safe to run after createObjects() — uses CREATE OR REPLACE VIEW.
 * Must be called after objects and fields exist in DuckDB.
 */
export async function createPivotViews(dbPath?: string): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    await conn.exec(`
      CREATE OR REPLACE VIEW v_account AS
      PIVOT (
        SELECT e.id as entry_id, e.created_at, e.updated_at,
               f.name as field_name, ef.value
        FROM entries e
        JOIN entry_fields ef ON ef.entry_id = e.id
        JOIN fields f ON f.id = ef.field_id
        WHERE e.object_id = (SELECT id FROM objects WHERE name = 'account')
          AND f.type != 'action'
      ) ON field_name IN (
        'Company Name', 'Domain', 'Industry', 'Employee Count',
        'Annual Revenue', 'HQ City', 'HQ Country', 'Owner', 'Phone', 'Website',
        'Description', 'Tags'
      ) USING first(value)
    `);

    await conn.exec(`
      CREATE OR REPLACE VIEW v_contact AS
      PIVOT (
        SELECT e.id as entry_id, e.created_at, e.updated_at,
               f.name as field_name, ef.value
        FROM entries e
        JOIN entry_fields ef ON ef.entry_id = e.id
        JOIN fields f ON f.id = ef.field_id
        WHERE e.object_id = (SELECT id FROM objects WHERE name = 'contact')
          AND f.type != 'action'
      ) ON field_name IN (
        'First Name', 'Last Name', 'Email Address', 'Phone Number',
        'Job Title', 'Department', 'Account', 'LinkedIn URL', 'Notes', 'Tags'
      ) USING first(value)
    `);

    await conn.exec(`
      CREATE OR REPLACE VIEW v_deal AS
      PIVOT (
        SELECT e.id as entry_id, e.created_at, e.updated_at,
               f.name as field_name, ef.value
        FROM entries e
        JOIN entry_fields ef ON ef.entry_id = e.id
        JOIN fields f ON f.id = ef.field_id
        WHERE e.object_id = (SELECT id FROM objects WHERE name = 'deal')
          AND f.type != 'action'
      ) ON field_name IN (
        'Deal Name', 'Account', 'Deal Value', 'Currency', 'Expected Close',
        'Owner', 'Lead Source', 'Probability', 'Description', 'Tags'
      ) USING first(value)
    `);
  } finally {
    await conn.close();
  }
}

/**
 * Creates or replaces a PIVOT view for a single object by querying the live fields table.
 * Use this (instead of createPivotViews) after adding a new field via schema evolution.
 */
export async function createDynamicPivotView(objectName: string, dbPath?: string): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<{ name: string }>(
      `SELECT f.name
       FROM fields f
       JOIN objects o ON f.object_id = o.id
       WHERE o.name = ? AND f.type != 'action'
       ORDER BY f.sort_order`,
      objectName,
    );
    if (rows.length === 0) return;
    const fieldList = rows.map((r) => `'${r.name.replace(/'/g, "''")}'`).join(', ');
    await conn.exec(
      `CREATE OR REPLACE VIEW v_${objectName} AS
       PIVOT (
         SELECT e.id as entry_id, e.created_at, e.updated_at,
                f.name as field_name, ef.value
         FROM entries e
         JOIN entry_fields ef ON ef.entry_id = e.id
         JOIN fields f ON f.id = ef.field_id
         WHERE e.object_id = (SELECT id FROM objects WHERE name = '${objectName.replace(/'/g, "''")}')
           AND f.type != 'action'
       ) ON field_name IN (${fieldList}) USING first(value)`,
    );
  } finally {
    await conn.close();
  }
}

/**
 * Creates workspace object directories and .object.yaml files at the given workspace path.
 * Maintains triple alignment: DuckDB objects.name == directory name == yaml name field.
 */
export function createObjectYamlFiles(workspacePath: string): void {
  const objects: Array<{ name: string; yaml: string }> = [
    { name: 'account', yaml: ACCOUNT_OBJECT_YAML },
    { name: 'contact', yaml: CONTACT_OBJECT_YAML },
    { name: 'deal', yaml: DEAL_OBJECT_YAML },
  ];

  for (const { name, yaml } of objects) {
    const dir = join(workspacePath, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.object.yaml'), yaml, 'utf8');
  }
}

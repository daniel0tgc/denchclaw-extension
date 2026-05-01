import { execQuery } from './db.js';

/**
 * Creates all standalone (non-EAV) tables used by the B2B CRM extension.
 * Idempotent — all statements use CREATE TABLE IF NOT EXISTS.
 */
export async function createStandaloneTables(dbPath?: string): Promise<void> {
  // line_items — deal line items with server-computed total
  await execQuery(`
    CREATE TABLE IF NOT EXISTS line_items (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      deal_entry_id VARCHAR NOT NULL,
      product_name VARCHAR NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price DOUBLE NOT NULL,
      total DOUBLE GENERATED ALWAYS AS (quantity * unit_price),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], dbPath);

  // transition_history — pipeline stage change log with duration
  await execQuery(`
    CREATE TABLE IF NOT EXISTS transition_history (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      entry_id VARCHAR NOT NULL,
      object_name VARCHAR NOT NULL,
      from_status VARCHAR,
      to_status VARCHAR NOT NULL,
      changed_by VARCHAR,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      duration_seconds BIGINT
    )
  `, [], dbPath);

  // contact_deal_roles — junction table with role constraint
  await execQuery(`
    CREATE TABLE IF NOT EXISTS contact_deal_roles (
      contact_entry_id VARCHAR NOT NULL,
      deal_entry_id VARCHAR NOT NULL,
      role VARCHAR NOT NULL CHECK (role IN ('champion', 'decision_maker', 'blocker', 'influencer', 'end_user', 'technical_evaluator')),
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contact_entry_id, deal_entry_id, role)
    )
  `, [], dbPath);

  // stakeholder_edges — directed relationship graph between contacts
  await execQuery(`
    CREATE TABLE IF NOT EXISTS stakeholder_edges (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      from_contact_id VARCHAR NOT NULL,
      to_contact_id VARCHAR NOT NULL,
      relationship_type VARCHAR NOT NULL CHECK (relationship_type IN ('reports_to', 'influences', 'blocks', 'champions_for', 'collaborates_with')),
      deal_id VARCHAR,
      weight DOUBLE NOT NULL DEFAULT 1.0,
      last_interaction_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], dbPath);

  await execQuery(`CREATE INDEX IF NOT EXISTS idx_stakeholder_from ON stakeholder_edges(from_contact_id)`, [], dbPath);
  await execQuery(`CREATE INDEX IF NOT EXISTS idx_stakeholder_deal ON stakeholder_edges(deal_id)`, [], dbPath);

  // activity_events — CRM operation event log with session support
  await execQuery(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      event_type VARCHAR NOT NULL,
      entity_type VARCHAR NOT NULL,
      entity_id VARCHAR NOT NULL,
      user_id VARCHAR,
      session_id VARCHAR,
      sequence_number INTEGER,
      metadata JSON,
      occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], dbPath);

  await execQuery(`CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_events(entity_type, entity_id)`, [], dbPath);
  await execQuery(`CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_events(occurred_at)`, [], dbPath);
  await execQuery(`CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_events(session_id, sequence_number)`, [], dbPath);

  // sync_state — per-field HLC timestamps for CRDT merge
  await execQuery(`
    CREATE TABLE IF NOT EXISTS sync_state (
      entry_id VARCHAR NOT NULL,
      field_id VARCHAR NOT NULL,
      value VARCHAR,
      hlc_ts BIGINT NOT NULL,
      hlc_counter INTEGER NOT NULL DEFAULT 0,
      node_id VARCHAR NOT NULL,
      PRIMARY KEY (entry_id, field_id)
    )
  `, [], dbPath);

  // sync_queue — decouples user writes from cloud sync
  await execQuery(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      operation VARCHAR NOT NULL CHECK (operation IN ('push', 'pull')),
      entry_id VARCHAR NOT NULL,
      field_id VARCHAR,
      value VARCHAR,
      hlc_ts BIGINT NOT NULL,
      hlc_counter INTEGER NOT NULL DEFAULT 0,
      node_id VARCHAR NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP
    )
  `, [], dbPath);

  await execQuery(`CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)`, [], dbPath);

  // import_errors — skip-and-log for bad CSV rows
  await execQuery(`
    CREATE TABLE IF NOT EXISTS import_errors (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      import_batch_id VARCHAR NOT NULL,
      row_number INTEGER NOT NULL,
      raw_data JSON NOT NULL,
      error_reason VARCHAR NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], dbPath);

  // audit_log — hash-chained tamper-evident trail
  await execQuery(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      action VARCHAR NOT NULL,
      entity_type VARCHAR NOT NULL,
      entity_id VARCHAR NOT NULL,
      actor_id VARCHAR,
      details JSON,
      prev_hash VARCHAR,
      hash VARCHAR NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], dbPath);

  await execQuery(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`, [], dbPath);

  // schema_versions — tracks field-level schema evolution per object per node
  await execQuery(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_name VARCHAR NOT NULL,
      field_name VARCHAR NOT NULL,
      field_type VARCHAR NOT NULL,
      version INTEGER NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      node_id VARCHAR NOT NULL
    )
  `, [], dbPath);

  // pending_field_values — stores field values for unknown fields until schema syncs
  await execQuery(`
    CREATE TABLE IF NOT EXISTS pending_field_values (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      entry_id VARCHAR NOT NULL,
      field_name VARCHAR NOT NULL,
      value VARCHAR,
      hlc_ts BIGINT NOT NULL,
      hlc_counter INTEGER NOT NULL,
      node_id VARCHAR NOT NULL,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], dbPath);

  // b2b_crm_schema_version — per-object schema version with hash for change detection
  await execQuery(`
    CREATE TABLE IF NOT EXISTS b2b_crm_schema_version (
      object_name VARCHAR NOT NULL,
      version INTEGER NOT NULL,
      fields_hash VARCHAR NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (object_name)
    )
  `, [], dbPath);
}

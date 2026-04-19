-- OpenClaw workspace seed schema + sample data
-- Used to pre-build workspace.duckdb for new workspace onboarding.

-- ── nanoid32 macro ──
CREATE OR REPLACE MACRO nanoid32() AS (
  SELECT string_agg(
    substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-',
      (floor(random() * 64) + 1)::int, 1), '')
  FROM generate_series(1, 32)
);

-- ── Core tables ──

-- NOTE: object icons are stored ONLY in `<objectDir>/.object.yaml` (single
-- source of truth). The legacy `icon` column has been retired — DO NOT add
-- it back here. Sidebar / search / object header all read yaml.
CREATE TABLE IF NOT EXISTS objects (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  name VARCHAR NOT NULL,
  description VARCHAR,
  default_view VARCHAR DEFAULT 'table',
  parent_document_id VARCHAR,
  sort_order INTEGER DEFAULT 0,
  source_app VARCHAR,
  immutable BOOLEAN DEFAULT false,
  hidden_in_sidebar BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS fields (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  name VARCHAR NOT NULL,
  description VARCHAR,
  type VARCHAR NOT NULL,
  required BOOLEAN DEFAULT false,
  default_value VARCHAR,
  related_object_id VARCHAR REFERENCES objects(id),
  relationship_type VARCHAR,
  enum_values JSON,
  enum_colors JSON,
  enum_multiple BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS entries (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entry_fields (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  entry_id VARCHAR NOT NULL REFERENCES entries(id),
  field_id VARCHAR NOT NULL REFERENCES fields(id),
  value VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entry_id, field_id)
);

CREATE TABLE IF NOT EXISTS statuses (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  name VARCHAR NOT NULL,
  color VARCHAR DEFAULT '#94a3b8',
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  title VARCHAR DEFAULT 'Untitled',
  icon VARCHAR,
  cover_image VARCHAR,
  file_path VARCHAR NOT NULL UNIQUE,
  parent_id VARCHAR REFERENCES documents(id),
  parent_object_id VARCHAR REFERENCES objects(id),
  entry_id VARCHAR REFERENCES entries(id),
  sort_order INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_runs (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  action_id VARCHAR NOT NULL,
  field_id VARCHAR NOT NULL,
  entry_id VARCHAR NOT NULL,
  object_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  result VARCHAR,
  error VARCHAR,
  stdout VARCHAR,
  exit_code INTEGER
);

-- ── Seed: people ──
-- (Icon for each seeded object lives in `<object>/.object.yaml` only.)

INSERT INTO objects (id, name, description, default_view, immutable, sort_order)
VALUES ('seed_obj_people_00000000000000', 'people', 'Contact management', 'table', true, 0);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_people_fullname_000000', 'seed_obj_people_00000000000000', 'Full Name', 'text', true, 0),
  ('seed_fld_people_email_000000000', 'seed_obj_people_00000000000000', 'Email Address', 'email', true, 1),
  ('seed_fld_people_phone_000000000', 'seed_obj_people_00000000000000', 'Phone Number', 'phone', false, 2);

-- The people.Company `relation` field declaration and its entry_fields are
-- inserted AFTER the company object + entries below (the FK on
-- `fields.related_object_id` and on `entry_fields.value` requires the
-- company rows to already exist).

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_people_status_00000000', 'seed_obj_people_00000000000000', 'Status', 'enum', false,
   '["Active","Inactive","Lead"]'::JSON, '["#22c55e","#94a3b8","#3b82f6"]'::JSON, 4);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_people_notes_000000000', 'seed_obj_people_00000000000000', 'Notes', 'richtext', false, 5);

INSERT INTO entries (id, object_id) VALUES
  ('seed_ent_people_sarah_000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_james_000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_maria_000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_alex_0000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_priya_000000000', 'seed_obj_people_00000000000000');

-- people.Company is a relation, declared + populated below the company
-- section so its FK references already exist when these rows land.
INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_fullname_000000', 'Sarah Chen'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_email_000000000', 'sarah@acmecorp.com'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 234-5678'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_status_00000000', 'Active'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_fullname_000000', 'James Wilson'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_email_000000000', 'james@techcorp.io'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 876-5432'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_status_00000000', 'Active'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_fullname_000000', 'Maria Garcia'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_email_000000000', 'maria@innovate.co'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 345-6789'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_status_00000000', 'Lead'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_fullname_000000', 'Alex Thompson'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_email_000000000', 'alex@designstudio.io'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_phone_000000000', '+1 (555) 567-8901'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_status_00000000', 'Active'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_fullname_000000', 'Priya Patel'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_email_000000000', 'priya@cloudnine.dev'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 789-0123'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_status_00000000', 'Lead');

CREATE OR REPLACE VIEW v_people AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_people_00000000000000'
) ON field_name IN ('Full Name', 'Email Address', 'Phone Number', 'Company', 'Status', 'Notes') USING first(value);

-- ── Seed: company ──

INSERT INTO objects (id, name, description, default_view, immutable, sort_order)
VALUES ('seed_obj_company_0000000000000', 'company', 'Company tracking', 'table', true, 1);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_name_000000000', 'seed_obj_company_0000000000000', 'Company Name', 'text', true, 0);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_company_industry_00000', 'seed_obj_company_0000000000000', 'Industry', 'enum', false,
   '["Technology","Finance","Healthcare","Education","Retail","Other"]'::JSON,
   '["#3b82f6","#22c55e","#ef4444","#f59e0b","#8b5cf6","#94a3b8"]'::JSON, 1);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_website_000000', 'seed_obj_company_0000000000000', 'Website', 'text', false, 2);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_company_type_000000000', 'seed_obj_company_0000000000000', 'Type', 'enum', false,
   '["Client","Partner","Vendor","Prospect"]'::JSON,
   '["#22c55e","#3b82f6","#f59e0b","#94a3b8"]'::JSON, 3);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_notes_00000000', 'seed_obj_company_0000000000000', 'Notes', 'richtext', false, 4);

INSERT INTO entries (id, object_id) VALUES
  ('seed_ent_company_acme_000000000', 'seed_obj_company_0000000000000'),
  ('seed_ent_company_tech_000000000', 'seed_obj_company_0000000000000'),
  ('seed_ent_company_innov_00000000', 'seed_obj_company_0000000000000');

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_company_acme_000000000', 'seed_fld_company_name_000000000', 'Acme Corp'),
  ('seed_ent_company_acme_000000000', 'seed_fld_company_industry_00000', 'Technology'),
  ('seed_ent_company_acme_000000000', 'seed_fld_company_website_000000', 'https://acmecorp.com'),
  ('seed_ent_company_acme_000000000', 'seed_fld_company_type_000000000', 'Client'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_name_000000000', 'TechCorp Industries'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_industry_00000', 'Finance'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_website_000000', 'https://techcorp.io'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_type_000000000', 'Partner'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_name_000000000', 'Innovate Co'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_industry_00000', 'Healthcare'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_website_000000', 'https://innovate.co'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_type_000000000', 'Prospect');

CREATE OR REPLACE VIEW v_company AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_company_0000000000000'
) ON field_name IN ('Company Name', 'Industry', 'Website', 'Type', 'Notes') USING first(value);

-- ── Seed: people.Company relation (declared after company exists) ──
-- The relation lets the unified ObjectTable show a "People (via Company)"
-- reverse column on the Companies table. Sarah/James/Maria link to the
-- seeded companies; Alex/Priya are intentionally left without a Company
-- so the empty state is also represented.
INSERT INTO fields (id, object_id, name, type, required, related_object_id, relationship_type, sort_order) VALUES
  ('seed_fld_people_company_0000000', 'seed_obj_people_00000000000000', 'Company', 'relation', false, 'seed_obj_company_0000000000000', 'many_to_one', 3);

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_company_0000000', 'seed_ent_company_acme_000000000'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_company_0000000', 'seed_ent_company_tech_000000000'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_company_0000000', 'seed_ent_company_innov_00000000');

-- ── Seed: task ──

INSERT INTO objects (id, name, description, default_view, sort_order)
VALUES ('seed_obj_task_000000000000000', 'task', 'Task tracking board', 'kanban', 2);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_task_title_00000000000', 'seed_obj_task_000000000000000', 'Title', 'text', true, 0),
  ('seed_fld_task_desc_000000000000', 'seed_obj_task_000000000000000', 'Description', 'text', false, 1);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_task_status_0000000000', 'seed_obj_task_000000000000000', 'Status', 'enum', false,
   '["In Queue","In Progress","Done"]'::JSON, '["#94a3b8","#3b82f6","#22c55e"]'::JSON, 2),
  ('seed_fld_task_priority_00000000', 'seed_obj_task_000000000000000', 'Priority', 'enum', false,
   '["Low","Medium","High"]'::JSON, '["#94a3b8","#f59e0b","#ef4444"]'::JSON, 3);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_task_duedate_000000000', 'seed_obj_task_000000000000000', 'Due Date', 'date', false, 4),
  ('seed_fld_task_notes_00000000000', 'seed_obj_task_000000000000000', 'Notes', 'richtext', false, 5);

INSERT INTO statuses (id, object_id, name, color, sort_order, is_default) VALUES
  ('seed_sts_task_queue_00000000000', 'seed_obj_task_000000000000000', 'In Queue', '#94a3b8', 0, true),
  ('seed_sts_task_progress_00000000', 'seed_obj_task_000000000000000', 'In Progress', '#3b82f6', 1, false),
  ('seed_sts_task_done_000000000000', 'seed_obj_task_000000000000000', 'Done', '#22c55e', 2, false);

INSERT INTO entries (id, object_id) VALUES
  ('seed_ent_task_review_0000000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_onboard_000000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_retro_00000000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_investor_00000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_dashperf_00000000', 'seed_obj_task_000000000000000');

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_task_review_0000000000', 'seed_fld_task_title_00000000000', 'Review Q1 reports'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_desc_000000000000', 'Review and summarize Q1 financial reports'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_status_0000000000', 'In Progress'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_priority_00000000', 'High'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_duedate_000000000', '2026-03-15'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_title_00000000000', 'Update client onboarding docs'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_desc_000000000000', 'Refresh the onboarding documentation with latest screenshots'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_status_0000000000', 'In Queue'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_priority_00000000', 'Medium'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_duedate_000000000', '2026-03-20'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_title_00000000000', 'Schedule team retrospective'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_desc_000000000000', 'Organize end-of-sprint retro for the team'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_status_0000000000', 'Done'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_priority_00000000', 'Low'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_title_00000000000', 'Prepare investor deck'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_desc_000000000000', 'Create presentation for upcoming investor meeting'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_status_0000000000', 'In Queue'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_priority_00000000', 'High'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_duedate_000000000', '2026-04-01'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_title_00000000000', 'Fix dashboard performance'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_desc_000000000000', 'Investigate and resolve slow loading on analytics dashboard'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_status_0000000000', 'In Progress'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_priority_00000000', 'Medium'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_duedate_000000000', '2026-03-10');

CREATE OR REPLACE VIEW v_task AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_task_000000000000000'
) ON field_name IN ('Title', 'Description', 'Status', 'Priority', 'Due Date', 'Notes') USING first(value);

-- ── Onboarding additions: extend people + company, add email/calendar/interaction objects ──
-- The web `workspace-schema-migrations.ts` runs the same DDL idempotently for
-- workspaces created before this seed shipped. Keep the two in sync.

-- people: Source, Strength Score, Last Interaction At, Job Title, LinkedIn URL, Avatar URL
INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_people_source_00000000', 'seed_obj_people_00000000000000', 'Source', 'enum', false,
   '["Manual","Gmail","Calendar"]'::JSON, '["#94a3b8","#ef4444","#3b82f6"]'::JSON, 10);
INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_people_strength_000000', 'seed_obj_people_00000000000000', 'Strength Score', 'number', false, 11),
  ('seed_fld_people_lastinter_00000', 'seed_obj_people_00000000000000', 'Last Interaction At', 'date', false, 12),
  ('seed_fld_people_jobtitle_000000', 'seed_obj_people_00000000000000', 'Job Title', 'text', false, 13),
  ('seed_fld_people_linkedin_000000', 'seed_obj_people_00000000000000', 'LinkedIn URL', 'url', false, 14),
  ('seed_fld_people_avatar_url_0000', 'seed_obj_people_00000000000000', 'Avatar URL', 'url', false, 15);

-- Mark all seeded people as Manual so the onboarding sync's `Source = Gmail`
-- filter doesn't accidentally show fixture rows as imported.
INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_source_00000000', 'Manual'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_source_00000000', 'Manual'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_source_00000000', 'Manual'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_source_00000000', 'Manual'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_source_00000000', 'Manual');

CREATE OR REPLACE VIEW v_people AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_people_00000000000000'
) ON field_name IN (
  'Full Name', 'Email Address', 'Phone Number', 'Company', 'Status', 'Notes',
  'Source', 'Strength Score', 'Last Interaction At', 'Job Title', 'LinkedIn URL', 'Avatar URL'
) USING first(value);

-- company: Source, Domain, Strength Score, Last Interaction At
INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_company_source_0000000', 'seed_obj_company_0000000000000', 'Source', 'enum', false,
   '["Manual","Gmail","Calendar"]'::JSON, '["#94a3b8","#ef4444","#3b82f6"]'::JSON, 10);
INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_domain_0000000', 'seed_obj_company_0000000000000', 'Domain', 'url', false, 11),
  ('seed_fld_company_strength_00000', 'seed_obj_company_0000000000000', 'Strength Score', 'number', false, 12),
  ('seed_fld_company_lastinter_0000', 'seed_obj_company_0000000000000', 'Last Interaction At', 'date', false, 13);

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_company_acme_000000000', 'seed_fld_company_source_0000000', 'Manual'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_source_0000000', 'Manual'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_source_0000000', 'Manual');

CREATE OR REPLACE VIEW v_company AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_company_0000000000000'
) ON field_name IN (
  'Company Name', 'Industry', 'Website', 'Type', 'Notes',
  'Source', 'Domain', 'Strength Score', 'Last Interaction At'
) USING first(value);

-- ── New object: email_thread ──
INSERT INTO objects (id, name, description, default_view, immutable, sort_order)
VALUES ('seed_obj_email_thread_000000000', 'email_thread', 'Email thread synced from Gmail', 'table', true, 10);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_emthread_subject_0000', 'seed_obj_email_thread_000000000', 'Subject', 'text', true, 0),
  ('seed_fld_emthread_lastat_00000', 'seed_obj_email_thread_000000000', 'Last Message At', 'date', false, 1),
  ('seed_fld_emthread_count_000000', 'seed_obj_email_thread_000000000', 'Message Count', 'number', false, 2);

INSERT INTO fields (id, object_id, name, type, required, related_object_id, relationship_type, sort_order) VALUES
  ('seed_fld_emthread_people_00000', 'seed_obj_email_thread_000000000', 'Participants', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_many', 3),
  ('seed_fld_emthread_company_0000', 'seed_obj_email_thread_000000000', 'Companies', 'relation', false, 'seed_obj_company_0000000000000', 'many_to_many', 4);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_emthread_threadid_000', 'seed_obj_email_thread_000000000', 'Gmail Thread ID', 'text', true, 5);

CREATE OR REPLACE VIEW v_email_thread AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_email_thread_000000000'
) ON field_name IN (
  'Subject', 'Last Message At', 'Message Count', 'Participants', 'Companies', 'Gmail Thread ID'
) USING first(value);

-- ── New object: email_message ──
INSERT INTO objects (id, name, description, default_view, immutable, sort_order)
VALUES ('seed_obj_email_message_00000000', 'email_message', 'Single email message synced from Gmail', 'table', true, 11);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_emmsg_subject_0000000', 'seed_obj_email_message_00000000', 'Subject', 'text', false, 0),
  ('seed_fld_emmsg_sentat_000000000', 'seed_obj_email_message_00000000', 'Sent At', 'date', false, 1);

INSERT INTO fields (id, object_id, name, type, required, related_object_id, relationship_type, sort_order) VALUES
  ('seed_fld_emmsg_from_00000000000', 'seed_obj_email_message_00000000', 'From', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_one', 2),
  ('seed_fld_emmsg_to_0000000000000', 'seed_obj_email_message_00000000', 'To', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_many', 3),
  ('seed_fld_emmsg_cc_0000000000000', 'seed_obj_email_message_00000000', 'Cc', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_many', 4),
  ('seed_fld_emmsg_thread_000000000', 'seed_obj_email_message_00000000', 'Thread', 'relation', false, 'seed_obj_email_thread_000000000', 'many_to_one', 5);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_emmsg_preview_00000000', 'seed_obj_email_message_00000000', 'Body Preview', 'text', false, 6),
  ('seed_fld_emmsg_body_00000000000', 'seed_obj_email_message_00000000', 'Body', 'richtext', false, 7),
  ('seed_fld_emmsg_attach_0000000000', 'seed_obj_email_message_00000000', 'Has Attachments', 'boolean', false, 8),
  ('seed_fld_emmsg_msgid_0000000000', 'seed_obj_email_message_00000000', 'Gmail Message ID', 'text', true, 9);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_emmsg_sndtype_00000000', 'seed_obj_email_message_00000000', 'Sender Type', 'enum', false,
   '["Person","Marketing","Transactional","Notification","Mailing List","Automated"]'::JSON,
   '["#22c55e","#ef4444","#3b82f6","#f59e0b","#8b5cf6","#94a3b8"]'::JSON, 10);

CREATE OR REPLACE VIEW v_email_message AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_email_message_00000000'
) ON field_name IN (
  'Subject', 'Sent At', 'From', 'To', 'Cc', 'Thread',
  'Body Preview', 'Body', 'Has Attachments', 'Gmail Message ID', 'Sender Type'
) USING first(value);

-- ── New object: calendar_event ──
INSERT INTO objects (id, name, description, default_view, immutable, sort_order)
VALUES ('seed_obj_calendar_event_0000000', 'calendar_event', 'Calendar event synced from Google Calendar', 'calendar', true, 12);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_calev_title_0000000000', 'seed_obj_calendar_event_0000000', 'Title', 'text', true, 0),
  ('seed_fld_calev_start_0000000000', 'seed_obj_calendar_event_0000000', 'Start At', 'date', true, 1),
  ('seed_fld_calev_end_000000000000', 'seed_obj_calendar_event_0000000', 'End At', 'date', false, 2);

INSERT INTO fields (id, object_id, name, type, required, related_object_id, relationship_type, sort_order) VALUES
  ('seed_fld_calev_organ_0000000000', 'seed_obj_calendar_event_0000000', 'Organizer', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_one', 3),
  ('seed_fld_calev_attend_000000000', 'seed_obj_calendar_event_0000000', 'Attendees', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_many', 4),
  ('seed_fld_calev_company_00000000', 'seed_obj_calendar_event_0000000', 'Companies', 'relation', false, 'seed_obj_company_0000000000000', 'many_to_many', 5);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_calev_meettype_0000000', 'seed_obj_calendar_event_0000000', 'Meeting Type', 'enum', false,
   '["One on One","Small Group","Large Group"]'::JSON, '["#22c55e","#3b82f6","#94a3b8"]'::JSON, 6);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_calev_eventid_00000000', 'seed_obj_calendar_event_0000000', 'Google Event ID', 'text', true, 7);

CREATE OR REPLACE VIEW v_calendar_event AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_calendar_event_0000000'
) ON field_name IN (
  'Title', 'Start At', 'End At', 'Organizer', 'Attendees', 'Companies', 'Meeting Type', 'Google Event ID'
) USING first(value);

-- ── New object: interaction ──
INSERT INTO objects (id, name, description, default_view, immutable, sort_order)
VALUES ('seed_obj_interaction_00000000000', 'interaction', 'Email or meeting between you and a contact (used for ranking)', 'timeline', true, 13);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_inter_type_00000000000', 'seed_obj_interaction_00000000000', 'Type', 'enum', false,
   '["Email","Meeting"]'::JSON, '["#3b82f6","#22c55e"]'::JSON, 0);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_inter_occurred_0000000', 'seed_obj_interaction_00000000000', 'Occurred At', 'date', true, 1);

INSERT INTO fields (id, object_id, name, type, required, related_object_id, relationship_type, sort_order) VALUES
  ('seed_fld_inter_person_000000000', 'seed_obj_interaction_00000000000', 'Person', 'relation', false, 'seed_obj_people_00000000000000', 'many_to_one', 2),
  ('seed_fld_inter_company_00000000', 'seed_obj_interaction_00000000000', 'Company', 'relation', false, 'seed_obj_company_0000000000000', 'many_to_one', 3),
  ('seed_fld_inter_email_0000000000', 'seed_obj_interaction_00000000000', 'Email', 'relation', false, 'seed_obj_email_message_00000000', 'many_to_one', 4),
  ('seed_fld_inter_event_0000000000', 'seed_obj_interaction_00000000000', 'Event', 'relation', false, 'seed_obj_calendar_event_0000000', 'many_to_one', 5);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_inter_direction_000000', 'seed_obj_interaction_00000000000', 'Direction', 'enum', false,
   '["Sent","Received","Internal"]'::JSON, '["#22c55e","#3b82f6","#94a3b8"]'::JSON, 6);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_inter_score_0000000000', 'seed_obj_interaction_00000000000', 'Score Contribution', 'number', false, 7);

CREATE OR REPLACE VIEW v_interaction AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_interaction_00000000000'
) ON field_name IN (
  'Type', 'Occurred At', 'Person', 'Company', 'Email', 'Event', 'Direction', 'Score Contribution'
) USING first(value);

-- Hide CRM-only objects from the workspace tree. They have dedicated UI
-- (people-list-view / inbox-view / calendar-view / person-profile / etc.)
-- and shouldn't clutter the file-system sidebar.
UPDATE objects SET hidden_in_sidebar = true
WHERE name IN ('email_thread', 'email_message', 'calendar_event', 'interaction');

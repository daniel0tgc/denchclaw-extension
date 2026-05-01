---
name: b2b-crm
description: Core B2B CRM operations — account, contact, and deal management with EAV schema, PIVOT views, and relation fields.
metadata: { "openclaw": { "inject": true, "always": true } }
---

# B2B CRM — Core Operations

All CRM data lives in `workspace.duckdb`. Objects (account, contact, deal) are stored in the EAV pattern. Query them via auto-generated PIVOT views: `v_account`, `v_contact`, `v_deal`.

**Field names use display names with spaces.** Always double-quote them in SQL: `"Company Name"`, `"Email Address"`.

---

## Creating an Account

```sql
-- 1. Insert the entry row
INSERT INTO entries (object_id)
VALUES ((SELECT id FROM objects WHERE name = 'account'))
RETURNING id;
-- capture the returned id as $entry_id

-- 2. Insert each field value
INSERT INTO entry_fields (entry_id, field_id, value)
VALUES
  ($entry_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='account') AND name='Company Name'), 'Acme Corp'),
  ($entry_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='account') AND name='Domain'),       'acme.com'),
  ($entry_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='account') AND name='Industry'),     'Manufacturing'),
  ($entry_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='account') AND name='Employee Count'),'1500'),
  ($entry_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='account') AND name='HQ City'),     'Detroit'),
  ($entry_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='account') AND name='HQ Country'),  'USA')
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value;
```

Valid `Industry` values: `Manufacturing`, `Energy`, `Chemicals`, `Mining`, `Agriculture`, `Construction`, `Logistics`, `Other`.

Account statuses: `prospect` (default), `active`, `churned`.

---

## Creating a Contact

```sql
INSERT INTO entries (object_id)
VALUES ((SELECT id FROM objects WHERE name = 'contact'))
RETURNING id;
-- capture as $contact_id

INSERT INTO entry_fields (entry_id, field_id, value)
VALUES
  ($contact_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='contact') AND name='First Name'),    'Jane'),
  ($contact_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='contact') AND name='Last Name'),     'Smith'),
  ($contact_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='contact') AND name='Email Address'), 'jane@acme.com'),
  ($contact_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='contact') AND name='Job Title'),     'VP Engineering'),
  -- Account relation: store the account entry_id as value
  ($contact_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='contact') AND name='Account'),      $account_entry_id)
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value;
```

Contact statuses: `active` (default), `inactive`.

---

## Creating a Deal

```sql
INSERT INTO entries (object_id)
VALUES ((SELECT id FROM objects WHERE name = 'deal'))
RETURNING id;
-- capture as $deal_id

INSERT INTO entry_fields (entry_id, field_id, value)
VALUES
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Deal Name'),      'Acme Q3 Expansion'),
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Account'),        $account_entry_id),
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Deal Value'),     '250000'),
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Currency'),       'USD'),
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Expected Close'), '2026-09-30'),
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Lead Source'),    'Inbound'),
  ($deal_id, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name='deal') AND name='Probability'),    '60')
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value;
```

Deal pipeline statuses (sort order): `prospecting` → `qualified` → `proposal` → `negotiation` → `won` → `lost`.

Valid `Currency` values: `USD`, `EUR`, `GBP`, `JPY`.
Valid `Lead Source` values: `Inbound`, `Outbound`, `Referral`, `Partner`, `Event`.

---

## Querying via PIVOT Views

```sql
-- All accounts
SELECT * FROM v_account ORDER BY created_at DESC LIMIT 50;

-- Filter by industry
SELECT "Company Name", "Domain", "Employee Count"
FROM v_account
WHERE "Industry" = 'Manufacturing'
ORDER BY "Company Name";

-- All contacts at a specific account
SELECT "First Name", "Last Name", "Email Address", "Job Title"
FROM v_contact
WHERE "Account" = $account_entry_id;

-- All deals for an account
SELECT "Deal Name", "Deal Value", "Currency", "Expected Close"
FROM v_deal
WHERE "Account" = $account_entry_id
ORDER BY "Expected Close";

-- Open deals (not won/lost)
SELECT d."Deal Name", d."Deal Value", s.name AS stage
FROM v_deal d
JOIN entries e ON e.id = d.entry_id
JOIN statuses s ON s.id = e.status_id
WHERE s.name NOT IN ('won', 'lost')
ORDER BY d."Expected Close";
```

---

## Updating a Field

```sql
UPDATE entry_fields
SET value = 'active', updated_at = CURRENT_TIMESTAMP
WHERE entry_id = $entry_id
  AND field_id = (
    SELECT id FROM fields
    WHERE name = 'Industry'
      AND object_id = (SELECT id FROM objects WHERE name = 'account')
  );
```

---

## Assigning a Contact Role on a Deal

Roles: `champion`, `decision_maker`, `blocker`, `influencer`, `end_user`, `technical_evaluator`.

```sql
INSERT INTO contact_deal_roles (contact_entry_id, deal_entry_id, role)
VALUES ($contact_id, $deal_id, 'champion')
ON CONFLICT (contact_entry_id, deal_entry_id, role) DO NOTHING;
```

Query contacts with roles for a deal:

```sql
SELECT
  c."First Name", c."Last Name", c."Job Title",
  cdr.role, cdr.assigned_at
FROM contact_deal_roles cdr
JOIN v_contact c ON c.entry_id = cdr.contact_entry_id
WHERE cdr.deal_entry_id = $deal_id
ORDER BY cdr.role;
```

---

## Stakeholder Relationship Mapping

Record directed relationships between contacts, optionally scoped to a deal.

```sql
INSERT INTO stakeholder_edges (from_contact_id, to_contact_id, relationship_type, deal_id, weight)
VALUES ($contact_a, $contact_b, 'reports_to', $deal_id, 1.0)
ON CONFLICT DO NOTHING;
```

Relationship types: `reports_to`, `influences`, `blocks`, `champions_for`, `collaborates_with`.

Query the stakeholder graph for a deal:

```sql
SELECT
  c."First Name" || ' ' || c."Last Name" AS name,
  c."Job Title",
  se.relationship_type,
  se.weight,
  se.last_interaction_at
FROM stakeholder_edges se
JOIN v_contact c ON c.entry_id = se.from_contact_id
WHERE se.deal_id = $deal_id
ORDER BY se.weight DESC;
```

Find decision-makers (contacts who report to no one in the graph for this deal):

```sql
SELECT c."First Name", c."Last Name", c."Job Title"
FROM v_contact c
JOIN contact_deal_roles cdr ON cdr.contact_entry_id = c.entry_id
WHERE cdr.deal_entry_id = $deal_id
  AND cdr.role = 'decision_maker'
  AND c.entry_id NOT IN (
    SELECT from_contact_id FROM stakeholder_edges
    WHERE deal_id = $deal_id AND relationship_type = 'reports_to'
  );
```

---

## Listing All Contacts for an Account

```sql
SELECT
  "First Name", "Last Name", "Email Address",
  "Job Title", "Phone Number"
FROM v_contact
WHERE "Account" = $account_entry_id
ORDER BY "Last Name", "First Name";
```

---

## Setting an Account Status

```sql
UPDATE entries
SET status_id = (
  SELECT id FROM statuses
  WHERE object_id = (SELECT id FROM objects WHERE name = 'account')
    AND name = 'active'
),
updated_at = CURRENT_TIMESTAMP
WHERE id = $entry_id;
```

/**
 * Integration tests for `mergeDuplicatePeople`.
 *
 * These spin up a real DuckDB file in a temp directory (using the same CLI
 * the production sync code uses) so we exercise the actual SQL we generate,
 * not a mock. The seed schema from `assets/seed/schema.sql` provides every
 * object/field id we reference, so test inserts can use the same
 * `seed_*` ids as production code.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { findDuplicateGroups, mergeDuplicatePeople } from "./people-merge";
import { clearCrmFieldMapCache } from "./crm-queries";
import { duckdbExecOnFileAsync, duckdbQueryAsync, resolveDuckdbBin } from "./workspace";

// ---------------------------------------------------------------------------
// Test fixture: temp workspace + seeded DuckDB
// ---------------------------------------------------------------------------

let tempHome = "";
let workspaceDir = "";
let dbPath = "";

const SCHEMA_PATH = resolve(__dirname, "../../../assets/seed/schema.sql");

const PEOPLE_OBJECT = "seed_obj_people_00000000000000";
const FLD_FULLNAME = "seed_fld_people_fullname_000000";
const FLD_EMAIL = "seed_fld_people_email_000000000";
const FLD_PHONE = "seed_fld_people_phone_000000000";
const FLD_COMPANY = "seed_fld_people_company_0000000";
const FLD_SOURCE = "seed_fld_people_source_00000000";
const FLD_JOBTITLE = "seed_fld_people_jobtitle_000000";

const FLD_INTERACTION_PERSON = "seed_fld_inter_person_000000000";
const FLD_INTERACTION_TYPE = "seed_fld_inter_type_00000000000";
const FLD_INTERACTION_OCCURRED = "seed_fld_inter_occurred_0000000";
const INTERACTION_OBJECT = "seed_obj_interaction_00000000000";

const FLD_EMTHREAD_PARTICIPANTS = "seed_fld_emthread_people_00000";
const FLD_EMTHREAD_SUBJECT = "seed_fld_emthread_subject_0000";
const FLD_EMTHREAD_GMAIL_ID = "seed_fld_emthread_threadid_000";
const EMAIL_THREAD_OBJECT = "seed_obj_email_thread_000000000";

const FLD_EMMSG_FROM = "seed_fld_emmsg_from_00000000000";
const FLD_EMMSG_GMAIL_ID = "seed_fld_emmsg_msgid_0000000000";
const EMAIL_MESSAGE_OBJECT = "seed_obj_email_message_00000000";

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function exec(statement: string): Promise<void> {
  const ok = await duckdbExecOnFileAsync(dbPath, statement);
  if (!ok) {
    throw new Error(`SQL exec failed: ${statement.slice(0, 200)}…`);
  }
}

async function insertPerson(params: {
  id: string;
  createdAt: string;
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  company?: string | null;
  source?: string | null;
  jobTitle?: string | null;
}): Promise<void> {
  const stmts: string[] = [];
  stmts.push(
    `INSERT INTO entries (id, object_id, created_at, updated_at) VALUES (${sql(params.id)}, ${sql(
      PEOPLE_OBJECT,
    )}, TIMESTAMP ${sql(params.createdAt)}, TIMESTAMP ${sql(params.createdAt)});`,
  );
  const pushField = (fieldId: string, value: string | null | undefined) => {
    if (value === null || value === undefined) {return;}
    stmts.push(
      `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(params.id)}, ${sql(
        fieldId,
      )}, ${sql(value)});`,
    );
  };
  pushField(FLD_FULLNAME, params.fullName);
  pushField(FLD_EMAIL, params.email);
  pushField(FLD_PHONE, params.phone);
  pushField(FLD_COMPANY, params.company);
  pushField(FLD_SOURCE, params.source);
  pushField(FLD_JOBTITLE, params.jobTitle);
  await exec(stmts.join("\n"));
}

async function countPeople(): Promise<number> {
  const rows = await duckdbQueryAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM entries WHERE object_id = ${sql(PEOPLE_OBJECT)};`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function readPersonField(
  entryId: string,
  fieldId: string,
): Promise<string | null> {
  const rows = await duckdbQueryAsync<{ value: string | null }>(
    `SELECT value FROM entry_fields WHERE entry_id = ${sql(entryId)} AND field_id = ${sql(
      fieldId,
    )};`,
  );
  return rows[0]?.value ?? null;
}

async function entryExists(entryId: string): Promise<boolean> {
  const rows = await duckdbQueryAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM entries WHERE id = ${sql(entryId)};`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  if (!resolveDuckdbBin()) {
    throw new Error(
      "duckdb CLI not found — install it (e.g. `brew install duckdb`) to run people-merge tests.",
    );
  }

  tempHome = mkdtempSync(join(tmpdir(), "denchclaw-people-merge-"));
  process.env.OPENCLAW_HOME = tempHome;
  workspaceDir = join(tempHome, ".openclaw-dench", "workspace-test");
  mkdirSync(workspaceDir, { recursive: true });
  process.env.OPENCLAW_WORKSPACE = workspaceDir;
  dbPath = join(workspaceDir, "workspace.duckdb");

  // Apply the full seed schema. We pipe via stdin (not -c) because the
  // schema file has multiple statements and contains single quotes that
  // a `-c` arg would mangle through shell escaping.
  const bin = resolveDuckdbBin()!;
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  execSync(`${bin} ${dbPath}`, { input: schema, encoding: "utf-8", timeout: 30_000 });

  clearCrmFieldMapCache();
});

afterEach(() => {
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_WORKSPACE;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = "";
  }
  clearCrmFieldMapCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findDuplicateGroups", () => {
  it("returns [] when no duplicates exist", async () => {
    await insertPerson({
      id: "test_p_unique_aaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "alone@kubeace.com",
    });
    const groups = await findDuplicateGroups();
    expect(groups).toEqual([]);
  });

  it("groups two rows whose emails differ only by +tag", async () => {
    await insertPerson({
      id: "test_p_dileep_a_aaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "dileep@kubeace.com",
    });
    await insertPerson({
      id: "test_p_dileep_b_bbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "dileep+work@kubeace.com",
    });
    const groups = await findDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe("test_p_dileep_a_aaaaaaaaaaaaaa");
    expect(groups[0].loserIds).toEqual(["test_p_dileep_b_bbbbbbbbbbbbbb"]);
  });

  it("groups two rows that share a normalized phone but not email", async () => {
    // Use phone numbers that don't collide with seed people (Sarah/James/Maria
    // /Alex/Priya use 555-234/876/345/567/789-XXXX); 5559991234 is unique.
    await insertPerson({
      id: "test_p_phone_a_aaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "alpha@example.com",
      phone: "+1 (555) 999-1234",
    });
    await insertPerson({
      id: "test_p_phone_b_bbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "beta@example.org",
      phone: "5559991234",
    });
    const groups = await findDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe("test_p_phone_a_aaaaaaaaaaaaaaa");
    expect(groups[0].loserIds).toEqual(["test_p_phone_b_bbbbbbbbbbbbbbb"]);
  });

  it("transitively groups A↔B by email and B↔C by phone into a single component", async () => {
    await insertPerson({
      id: "test_p_a_aaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "shared@kubeace.com",
    });
    await insertPerson({
      id: "test_p_b_bbbbbbbbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "shared+x@kubeace.com",
      phone: "555-999-1234",
    });
    await insertPerson({
      id: "test_p_c_ccccccccccccccccccccc",
      createdAt: "2026-01-03 10:00:00",
      phone: "+1 555 999 1234",
    });
    const groups = await findDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe("test_p_a_aaaaaaaaaaaaaaaaaaaaa");
    expect(new Set(groups[0].loserIds)).toEqual(
      new Set(["test_p_b_bbbbbbbbbbbbbbbbbbbbb", "test_p_c_ccccccccccccccccccccc"]),
    );
  });
});

describe("mergeDuplicatePeople", () => {
  it("no-op when there are no duplicates", async () => {
    await insertPerson({
      id: "test_p_solo_aaaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "solo@kubeace.com",
    });
    const before = await countPeople();
    const report = await mergeDuplicatePeople();
    expect(report.groupsFound).toBe(0);
    expect(report.rowsMerged).toBe(0);
    expect(await countPeople()).toBe(before);
  });

  it("collapses email-+tag duplicates onto the older entry", async () => {
    await insertPerson({
      id: "test_p_dileep_a_aaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "dileep@kubeace.com",
      fullName: "Dileep K",
    });
    await insertPerson({
      id: "test_p_dileep_b_bbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "dileep+work@kubeace.com",
    });

    const beforeCount = await countPeople();
    const report = await mergeDuplicatePeople();

    expect(report.groupsFound).toBe(1);
    expect(report.rowsMerged).toBe(1);
    expect(await entryExists("test_p_dileep_a_aaaaaaaaaaaaaa")).toBe(true);
    expect(await entryExists("test_p_dileep_b_bbbbbbbbbbbbbb")).toBe(false);
    expect(await countPeople()).toBe(beforeCount - 1);
  });

  it("merges by phone when emails differ but normalized phone matches", async () => {
    await insertPerson({
      id: "test_p_phone_a_aaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "alpha@example.com",
      phone: "+1 (555) 999-1234",
    });
    await insertPerson({
      id: "test_p_phone_b_bbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "beta@example.org",
      phone: "5559991234",
    });

    const report = await mergeDuplicatePeople();
    expect(report.rowsMerged).toBe(1);
    expect(await entryExists("test_p_phone_a_aaaaaaaaaaaaaaa")).toBe(true);
    expect(await entryExists("test_p_phone_b_bbbbbbbbbbbbbbb")).toBe(false);
  });

  it("transitively collapses 3-way (A↔B by email, B↔C by phone) into one canonical", async () => {
    await insertPerson({
      id: "test_p_a_aaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "shared@kubeace.com",
    });
    await insertPerson({
      id: "test_p_b_bbbbbbbbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "shared+x@kubeace.com",
      phone: "555-999-1234",
    });
    await insertPerson({
      id: "test_p_c_ccccccccccccccccccccc",
      createdAt: "2026-01-03 10:00:00",
      phone: "+1 555 999 1234",
    });

    const report = await mergeDuplicatePeople();
    expect(report.groupsFound).toBe(1);
    expect(report.rowsMerged).toBe(2);
    expect(await entryExists("test_p_a_aaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(await entryExists("test_p_b_bbbbbbbbbbbbbbbbbbbbb")).toBe(false);
    expect(await entryExists("test_p_c_ccccccccccccccccccccc")).toBe(false);
  });

  it("copies loser fields onto canonical only when canonical has no value", async () => {
    // Canonical: has Source=Gmail (older), no name, no Job Title.
    await insertPerson({
      id: "test_p_canon_aaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "user@kubeace.com",
      source: "Gmail",
    });
    // Loser: has name + Job Title + a different Source.
    await insertPerson({
      id: "test_p_loser_bbbbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "user+work@kubeace.com",
      fullName: "User McUserface",
      source: "Calendar",
      jobTitle: "Eng",
    });

    await mergeDuplicatePeople();

    // Source: canonical wins because it already had a value.
    expect(await readPersonField("test_p_canon_aaaaaaaaaaaaaaaaa", FLD_SOURCE)).toBe("Gmail");
    // Full Name: canonical was empty, loser's value gets copied across.
    expect(await readPersonField("test_p_canon_aaaaaaaaaaaaaaaaa", FLD_FULLNAME)).toBe(
      "User McUserface",
    );
    // Job Title: only the loser had it, so it lands on canonical.
    expect(await readPersonField("test_p_canon_aaaaaaaaaaaaaaaaa", FLD_JOBTITLE)).toBe("Eng");
  });

  it("rewrites a many_to_one relation (interaction.Person) onto the canonical", async () => {
    await insertPerson({
      id: "test_p_canon_aaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "user@kubeace.com",
    });
    await insertPerson({
      id: "test_p_loser_bbbbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "user+x@kubeace.com",
    });
    // Interaction whose Person points at the loser.
    const interactionId = "test_int_aaaaaaaaaaaaaaaaaaaaaa";
    await exec(
      [
        `INSERT INTO entries (id, object_id, created_at) VALUES (${sql(
          interactionId,
        )}, ${sql(INTERACTION_OBJECT)}, TIMESTAMP '2026-01-03 10:00:00');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(
          interactionId,
        )}, ${sql(FLD_INTERACTION_TYPE)}, 'Email');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(
          interactionId,
        )}, ${sql(FLD_INTERACTION_OCCURRED)}, '2026-01-03T10:00:00.000Z');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(
          interactionId,
        )}, ${sql(FLD_INTERACTION_PERSON)}, ${sql(
          "test_p_loser_bbbbbbbbbbbbbbbbb",
        )});`,
      ].join("\n"),
    );

    const report = await mergeDuplicatePeople();
    expect(report.relationsRemapped).toBeGreaterThanOrEqual(1);

    // The interaction's Person field should now point at the canonical.
    expect(await readPersonField(interactionId, FLD_INTERACTION_PERSON)).toBe(
      "test_p_canon_aaaaaaaaaaaaaaaaa",
    );
  });

  it("rewrites many_to_many JSON arrays and dedupes when both ids are present", async () => {
    await insertPerson({
      id: "test_p_canon_aaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "user@kubeace.com",
    });
    await insertPerson({
      id: "test_p_loser_bbbbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "user+x@kubeace.com",
    });
    // A third unrelated person who's also in the thread participants.
    await insertPerson({
      id: "test_p_other_ccccccccccccccccc",
      createdAt: "2026-01-01 10:00:00",
      email: "other@example.com",
    });

    // Thread containing canonical + loser + other in Participants.
    const threadId = "test_thr_aaaaaaaaaaaaaaaaaaaaaa";
    const participantsJson = JSON.stringify([
      "test_p_canon_aaaaaaaaaaaaaaaaa",
      "test_p_loser_bbbbbbbbbbbbbbbbb",
      "test_p_other_ccccccccccccccccc",
    ]);
    await exec(
      [
        `INSERT INTO entries (id, object_id, created_at) VALUES (${sql(threadId)}, ${sql(
          EMAIL_THREAD_OBJECT,
        )}, TIMESTAMP '2026-01-03 10:00:00');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(threadId)}, ${sql(
          FLD_EMTHREAD_SUBJECT,
        )}, 'Test thread');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(threadId)}, ${sql(
          FLD_EMTHREAD_GMAIL_ID,
        )}, 'gmail-thread-1');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(threadId)}, ${sql(
          FLD_EMTHREAD_PARTICIPANTS,
        )}, ${sql(participantsJson)});`,
      ].join("\n"),
    );

    await mergeDuplicatePeople();

    const stored = await readPersonField(threadId, FLD_EMTHREAD_PARTICIPANTS);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string) as string[];
    expect(parsed).toContain("test_p_canon_aaaaaaaaaaaaaaaaa");
    expect(parsed).toContain("test_p_other_ccccccccccccccccc");
    expect(parsed).not.toContain("test_p_loser_bbbbbbbbbbbbbbbbb");
    // Dedupe: canonical should appear exactly once, even though the original
    // array had both canonical + loser before remap.
    expect(parsed.filter((id) => id === "test_p_canon_aaaaaaaaaaaaaaaaa")).toHaveLength(1);
  });

  it("is idempotent — second run reports rowsMerged: 0", async () => {
    await insertPerson({
      id: "test_p_dileep_a_aaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "dileep@kubeace.com",
    });
    await insertPerson({
      id: "test_p_dileep_b_bbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "dileep+work@kubeace.com",
    });

    const first = await mergeDuplicatePeople();
    expect(first.rowsMerged).toBe(1);
    const second = await mergeDuplicatePeople();
    expect(second.groupsFound).toBe(0);
    expect(second.rowsMerged).toBe(0);
  });

  it("merges email_message.From (many_to_one to people) onto the canonical", async () => {
    await insertPerson({
      id: "test_p_canon_aaaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01 10:00:00",
      email: "user@kubeace.com",
    });
    await insertPerson({
      id: "test_p_loser_bbbbbbbbbbbbbbbbb",
      createdAt: "2026-01-02 10:00:00",
      email: "user+x@kubeace.com",
    });
    const messageId = "test_msg_aaaaaaaaaaaaaaaaaaaaaa";
    await exec(
      [
        `INSERT INTO entries (id, object_id, created_at) VALUES (${sql(messageId)}, ${sql(
          EMAIL_MESSAGE_OBJECT,
        )}, TIMESTAMP '2026-01-03 10:00:00');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(messageId)}, ${sql(
          FLD_EMMSG_GMAIL_ID,
        )}, 'gmail-msg-1');`,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(messageId)}, ${sql(
          FLD_EMMSG_FROM,
        )}, ${sql("test_p_loser_bbbbbbbbbbbbbbbbb")});`,
      ].join("\n"),
    );

    await mergeDuplicatePeople();

    expect(await readPersonField(messageId, FLD_EMMSG_FROM)).toBe(
      "test_p_canon_aaaaaaaaaaaaaaaaa",
    );
  });
});

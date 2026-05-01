import { randomUUID } from "node:crypto";
import { getConnection } from "./db.js";

const INDUSTRIES = [
  "Manufacturing",
  "Energy",
  "Chemicals",
  "Mining",
  "Agriculture",
  "Construction",
  "Logistics",
  "Other",
] as const;

const CITIES = [
  "New York", "Los Angeles", "Chicago", "Houston", "Phoenix",
  "Philadelphia", "San Antonio", "San Diego", "Dallas", "Austin",
  "London", "Berlin", "Paris", "Tokyo", "Singapore",
  "Sydney", "Toronto", "Dubai", "Seoul", "Mumbai",
];

const COUNTRIES = [
  "United States", "United Kingdom", "Germany", "France", "Japan",
  "Australia", "Canada", "UAE", "South Korea", "India",
];

const INDUSTRY_PREFIXES: Record<string, string[]> = {
  Manufacturing: ["Apex", "Summit", "Pinnacle", "Forge", "Titan", "Atlas", "Sterling", "Vanguard"],
  Energy: ["Solar", "Volt", "Flux", "Meridian", "Zenith", "Crest", "Vector", "Peak"],
  Chemicals: ["Nexus", "Catalyst", "Synth", "Prism", "Core", "Element", "Alloy", "Fusion"],
  Mining: ["Deep", "Vein", "Ore", "Shaft", "Ridge", "Quarry", "Strata", "Drift"],
  Agriculture: ["Green", "Harvest", "Field", "Grove", "Bloom", "Terra", "Sow", "Crop"],
  Construction: ["Build", "Frame", "Girder", "Arch", "Span", "Beam", "Keystone", "Pillar"],
  Logistics: ["Route", "Fleet", "Cargo", "Haul", "Swift", "Link", "Chain", "Relay"],
  Other: ["Venture", "Prime", "Alpha", "Sigma", "Delta", "Omni", "Meta", "Global"],
};

const SUFFIXES = [
  "Corp", "Inc", "LLC", "Ltd", "Co", "Group", "Holdings",
  "Industries", "Solutions", "Enterprises", "Partners", "Technologies",
];

/**
 * Simple Box-Muller normal variate — returns a standard normal sample.
 */
function randn(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Log-normal sample: e^(mu + sigma*Z)
 */
function lognormal(mu: number, sigma: number): number {
  return Math.exp(mu + sigma * randn());
}

function randomElement<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateCompanyName(industry: string): string {
  const prefixes = INDUSTRY_PREFIXES[industry] ?? INDUSTRY_PREFIXES["Other"] ?? ["Global"];
  const prefix = randomElement(prefixes);
  const suffix = randomElement(SUFFIXES);
  const num = Math.random() < 0.3 ? ` ${Math.floor(Math.random() * 900 + 100)}` : "";
  return `${prefix} ${industry}${num} ${suffix}`;
}

interface AccountFixture {
  entryId: string;
  companyName: string;
  domain: string;
  industry: string;
  employeeCount: number;
  annualRevenue: number;
  hqCity: string;
  hqCountry: string;
}

function generateAccount(index: number): AccountFixture {
  const industry = INDUSTRIES[index % INDUSTRIES.length];
  const companyName = generateCompanyName(industry);
  const domainSlug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  // Employee count: log-normal centered around ln(500), spread 1.5 → range roughly 10–100K
  const employeeCount = Math.max(10, Math.round(lognormal(6.2, 1.5)));
  // Revenue: log-normal centered around ln(50M), spread 1.5 → range roughly $100K–$10B
  const annualRevenue = Math.max(100_000, Math.round(lognormal(17.7, 1.5) / 1000) * 1000);

  return {
    entryId: randomUUID(),
    companyName,
    domain: `https://${domainSlug}.com`,
    industry,
    employeeCount,
    annualRevenue,
    hqCity: randomElement(CITIES),
    hqCountry: randomElement(COUNTRIES),
  };
}

/**
 * Generates `count` synthetic accounts and inserts them into DuckDB via EAV.
 * Inserts in batches of 100 for performance.
 * Returns the number of accounts inserted.
 */
export async function generateSyntheticAccounts(
  count: number = 10_000,
  dbPath?: string,
): Promise<number> {
  const conn = await getConnection(dbPath);
  let inserted = 0;

  try {
    // Resolve field IDs for account fields once
    type FieldRow = { id: string; name: string };
    const fieldRows = await conn.all<FieldRow>(
      `SELECT f.id, f.name
       FROM fields f
       JOIN objects o ON f.object_id = o.id
       WHERE o.name = 'account'`,
    );
    const fieldMap = new Map<string, string>(fieldRows.map((r) => [r.name, r.id]));

    const fieldNames = [
      "Company Name",
      "Domain",
      "Industry",
      "Employee Count",
      "Annual Revenue",
      "HQ City",
      "HQ Country",
    ];

    const batchSize = 100;
    for (let start = 0; start < count; start += batchSize) {
      const end = Math.min(start + batchSize, count);
      const batch: AccountFixture[] = [];
      for (let i = start; i < end; i++) {
        batch.push(generateAccount(i));
      }

      await conn.run("BEGIN");
      try {
        for (const acct of batch) {
          // Insert entry row
          await conn.run(
            `INSERT INTO entries (id, object_id, sort_order, created_at, updated_at)
             SELECT ?, id, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM objects WHERE name = 'account'`,
            acct.entryId,
          );

          // Insert field values
          const fieldValues: Record<string, string> = {
            "Company Name": acct.companyName,
            Domain: acct.domain,
            Industry: acct.industry,
            "Employee Count": String(acct.employeeCount),
            "Annual Revenue": String(acct.annualRevenue),
            "HQ City": acct.hqCity,
            "HQ Country": acct.hqCountry,
          };

          for (const fieldName of fieldNames) {
            const fieldId = fieldMap.get(fieldName);
            if (!fieldId) continue;
            await conn.run(
              `INSERT INTO entry_fields (entry_id, field_id, value)
               VALUES (?, ?, ?)
               ON CONFLICT (entry_id, field_id) DO NOTHING`,
              acct.entryId,
              fieldId,
              fieldValues[fieldName],
            );
          }
        }
        await conn.run("COMMIT");
        inserted += batch.length;
      } catch (err) {
        await conn.run("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await conn.close();
  }

  return inserted;
}

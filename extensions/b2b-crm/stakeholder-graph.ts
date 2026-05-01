import { getConnection } from './db.js';

export interface StakeholderNode {
  contactId: string;
  name: string;
  role: string;
  influenceScore: number;
  lastInteractionDaysAgo: number | null;
}

export interface StakeholderMap {
  dealId: string;
  nodes: StakeholderNode[];
  edges: Array<{ from: string; to: string; type: string; weight: number }>;
  riskFactors: string[];
}

// Role base weights for influence scoring
const ROLE_WEIGHTS: Record<string, number> = {
  decision_maker:      5,
  champion:            4,
  influencer:          3,
  end_user:            2,
  technical_evaluator: 2,
  blocker:            -3,
};

function roleWeight(role: string): number {
  return ROLE_WEIGHTS[role] ?? 1;
}

interface RoleRow {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  last_interaction: Date | null;
}

interface EdgeRow {
  from_contact_id: string;
  to_contact_id: string;
  relationship_type: string;
  weight: number;
  last_interaction_at: Date | null;
}

/** Queries stakeholder nodes (contacts + roles) for a deal. */
async function queryNodes(dealId: string, conn: Awaited<ReturnType<typeof getConnection>>): Promise<RoleRow[]> {
  return conn.all<RoleRow>(
    `SELECT cdr.contact_entry_id AS contact_id,
       vc."First Name" AS first_name, vc."Last Name" AS last_name,
       cdr.role,
       MAX(ae.occurred_at) AS last_interaction
     FROM contact_deal_roles cdr
     JOIN v_contact vc ON vc.entry_id = cdr.contact_entry_id
     LEFT JOIN activity_events ae
       ON ae.entity_id = cdr.contact_entry_id AND ae.entity_type = 'contact'
     WHERE cdr.deal_entry_id = ?
     GROUP BY cdr.contact_entry_id, vc."First Name", vc."Last Name", cdr.role`,
    dealId,
  );
}

/** Queries directed stakeholder edges for a deal. */
async function queryEdges(dealId: string, conn: Awaited<ReturnType<typeof getConnection>>): Promise<EdgeRow[]> {
  return conn.all<EdgeRow>(
    `SELECT from_contact_id, to_contact_id, relationship_type, weight, last_interaction_at
     FROM stakeholder_edges
     WHERE deal_id = ?`,
    dealId,
  );
}

function buildNode(r: RoleRow): StakeholderNode {
  const daysAgo = r.last_interaction
    ? Math.floor((Date.now() - new Date(r.last_interaction).getTime()) / 86_400_000)
    : null;
  const recencyDecay = daysAgo != null ? 1 / (1 + daysAgo) : 0;
  return {
    contactId: r.contact_id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.contact_id,
    role: r.role,
    influenceScore: roleWeight(r.role) * recencyDecay,
    lastInteractionDaysAgo: daysAgo,
  };
}

export async function scoreStakeholderInfluence(dealId: string, dbPath?: string): Promise<StakeholderNode[]> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await queryNodes(dealId, conn);
    return rows.map(buildNode).sort((a, b) => b.influenceScore - a.influenceScore);
  } finally {
    await conn.close();
  }
}

export async function detectStakeholderRisks(dealId: string, dbPath?: string): Promise<string[]> {
  const conn = await getConnection(dbPath);
  const risks: string[] = [];
  try {
    const nodes = await queryNodes(dealId, conn);
    const roles = nodes.map((n) => n.role);
    const uniqueContacts = new Set(nodes.map((n) => n.contact_id)).size;

    if (!roles.includes('decision_maker'))
      risks.push('No decision maker identified');

    if (uniqueContacts <= 1)
      risks.push('Single-threaded deal — only one contact engaged');

    const champions = nodes.filter((n) => n.role === 'champion');
    if (champions.length > 0) {
      const coldChampion = champions.find((n) => {
        const daysAgo = n.last_interaction
          ? Math.floor((Date.now() - new Date(n.last_interaction).getTime()) / 86_400_000)
          : 999;
        return daysAgo >= 14;
      });
      if (coldChampion) risks.push('Champion has gone cold — no interaction in 14+ days');
    }

    if (roles.includes('blocker') && !roles.includes('champion'))
      risks.push('Blocker present with no counter-champion');
  } finally {
    await conn.close();
  }
  return risks;
}

export async function getStakeholderMap(dealId: string, dbPath?: string): Promise<StakeholderMap> {
  const conn = await getConnection(dbPath);
  try {
    const [nodeRows, edgeRows] = await Promise.all([
      queryNodes(dealId, conn),
      queryEdges(dealId, conn),
    ]);
    const nodes = nodeRows.map(buildNode);
    const edges = edgeRows.map((e) => ({
      from: e.from_contact_id,
      to: e.to_contact_id,
      type: e.relationship_type,
      weight: Number(e.weight),
    }));
    const roles = nodeRows.map((n) => n.role);
    const uniqueContacts = new Set(nodeRows.map((n) => n.contact_id)).size;
    const risks: string[] = [];
    if (!roles.includes('decision_maker')) risks.push('No decision maker identified');
    if (uniqueContacts <= 1) risks.push('Single-threaded deal — only one contact engaged');
    const coldChampion = nodeRows.find((n) => {
      if (n.role !== 'champion') return false;
      const daysAgo = n.last_interaction
        ? Math.floor((Date.now() - new Date(n.last_interaction).getTime()) / 86_400_000)
        : 999;
      return daysAgo >= 14;
    });
    if (coldChampion) risks.push('Champion has gone cold — no interaction in 14+ days');
    if (roles.includes('blocker') && !roles.includes('champion'))
      risks.push('Blocker present with no counter-champion');

    return { dealId, nodes, edges, riskFactors: risks };
  } finally {
    await conn.close();
  }
}

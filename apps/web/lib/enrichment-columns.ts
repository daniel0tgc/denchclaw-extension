// ---------------------------------------------------------------------------
// Enrichment column definitions, object category detection, and helpers
// for the Apollo enrichment feature.
// ---------------------------------------------------------------------------

export type EnrichmentCategory = "people" | "company";

export type EnrichmentColumnDef = {
	label: string;
	key: string;
	fieldType: string;
	/** Dot-path into the Apollo response payload to extract the value. */
	apolloPath: string;
};

export type EnrichmentInputDef = {
	/** What kind of input is needed (for auto-detection heuristics). */
	kind: "email" | "linkedin" | "domain";
	label: string;
};

// ---------------------------------------------------------------------------
// Object category detection
// ---------------------------------------------------------------------------

const PEOPLE_PATTERNS = /people|person|contact|lead|prospect/i;
const COMPANY_PATTERNS = /company|companies|organization|account|business/i;

export function detectEnrichmentCategory(
	objectName: string,
): EnrichmentCategory | null {
	if (PEOPLE_PATTERNS.test(objectName)) return "people";
	if (COMPANY_PATTERNS.test(objectName)) return "company";
	return null;
}

// ---------------------------------------------------------------------------
// Column definitions per category
// ---------------------------------------------------------------------------

export const PEOPLE_ENRICHMENT_COLUMNS: EnrichmentColumnDef[] = [
	{ label: "Full Name", key: "person.name", fieldType: "text", apolloPath: "person.name" },
	{ label: "Email", key: "person.email", fieldType: "email", apolloPath: "person.email" },
	{ label: "Headline", key: "person.headline", fieldType: "text", apolloPath: "person.headline" },
	{ label: "LinkedIn URL", key: "person.linkedin_url", fieldType: "url", apolloPath: "person.linkedin_url" },
	{ label: "Twitter URL", key: "person.twitter_url", fieldType: "url", apolloPath: "person.twitter_url" },
	{ label: "Phone", key: "person.phone", fieldType: "phone", apolloPath: "person.contact.phone_numbers.0.sanitized_number" },
	{ label: "Title", key: "person.title", fieldType: "text", apolloPath: "person.title" },
	{ label: "Location", key: "person.location", fieldType: "text", apolloPath: "__computed.location" },
];

export const COMPANY_ENRICHMENT_COLUMNS: EnrichmentColumnDef[] = [
	{ label: "Company Name", key: "organization.name", fieldType: "text", apolloPath: "organization.name" },
	{ label: "Website URL", key: "organization.website_url", fieldType: "url", apolloPath: "organization.website_url" },
	{ label: "Industry", key: "organization.industry", fieldType: "text", apolloPath: "organization.industry" },
	{ label: "LinkedIn URL", key: "organization.linkedin_url", fieldType: "url", apolloPath: "organization.linkedin_url" },
	{ label: "Total Funding", key: "organization.total_funding_printed", fieldType: "text", apolloPath: "organization.total_funding_printed" },
	{ label: "Founded Year", key: "organization.founded_year", fieldType: "number", apolloPath: "organization.founded_year" },
];

export function getEnrichmentColumns(
	category: EnrichmentCategory,
): EnrichmentColumnDef[] {
	return category === "people"
		? PEOPLE_ENRICHMENT_COLUMNS
		: COMPANY_ENRICHMENT_COLUMNS;
}

// ---------------------------------------------------------------------------
// Input requirements per category
// ---------------------------------------------------------------------------

export const PEOPLE_INPUTS: EnrichmentInputDef[] = [
	{ kind: "email", label: "Email" },
	{ kind: "linkedin", label: "LinkedIn URL" },
];

export const COMPANY_INPUTS: EnrichmentInputDef[] = [
	{ kind: "domain", label: "Website / Domain" },
	{ kind: "linkedin", label: "LinkedIn URL" },
];

export function getInputDefs(category: EnrichmentCategory): EnrichmentInputDef[] {
	return category === "people" ? PEOPLE_INPUTS : COMPANY_INPUTS;
}

// ---------------------------------------------------------------------------
// Auto-detect an input column from existing fields
// ---------------------------------------------------------------------------

export type FieldCandidate = { id: string; name: string; type: string };

export function isEligibleInputField(
	category: EnrichmentCategory,
	field: FieldCandidate,
): boolean {
	if (category === "people") {
		return field.type === "email" || /^e[-_]?mail/i.test(field.name) || /linkedin/i.test(field.name);
	}

	return (
		/domain|website/i.test(field.name)
		|| /linkedin/i.test(field.name)
		|| (/^url$/i.test(field.name) && field.type === "url")
	);
}

export function getEligibleInputFields(
	category: EnrichmentCategory,
	fields: FieldCandidate[],
): FieldCandidate[] {
	return fields.filter((field) => isEligibleInputField(category, field));
}

export function autoDetectInputField(
	category: EnrichmentCategory,
	fields: FieldCandidate[],
): FieldCandidate | null {
	const eligibleFields = getEligibleInputFields(category, fields);
	if (category === "people") {
		const emailField = eligibleFields.find(
			(f) => f.type === "email" || /^e[-_]?mail/i.test(f.name),
		);
		if (emailField) return emailField;
		const linkedinField = eligibleFields.find(
			(f) => /linkedin/i.test(f.name),
		);
		if (linkedinField) return linkedinField;
	} else {
		const domainField = eligibleFields.find(
			(f) => /website|domain|^url$/i.test(f.name),
		);
		if (domainField) return domainField;
		const linkedinField = eligibleFields.find(
			(f) => /linkedin/i.test(f.name),
		);
		if (linkedinField) return linkedinField;
	}
	return null;
}

/** Determine input kind from the matched field. */
export function inferInputKind(
	field: FieldCandidate,
): "email" | "linkedin" | "domain" {
	if (field.type === "email" || /^e[-_]?mail/i.test(field.name)) return "email";
	if (/linkedin/i.test(field.name)) return "linkedin";
	return "domain";
}

// ---------------------------------------------------------------------------
// Extract a value from the Apollo response using a dot-path
// ---------------------------------------------------------------------------

export function extractApolloValue(
	payload: Record<string, unknown>,
	apolloPath: string,
): string | null {
	if (apolloPath === "__computed.location") {
		return computeLocation(payload);
	}

	const parts = apolloPath.split(".");
	let current: unknown = payload;
	for (const part of parts) {
		if (current == null || typeof current !== "object") return null;
		const idx = Number(part);
		if (Array.isArray(current) && !Number.isNaN(idx)) {
			current = current[idx];
		} else {
			current = (current as Record<string, unknown>)[part];
		}
	}
	if (current == null) return null;
	if (typeof current === "object") return JSON.stringify(current);
	return String(current);
}

function computeLocation(payload: Record<string, unknown>): string | null {
	const person = payload.person as Record<string, unknown> | undefined;
	if (!person) return null;
	const parts = [person.city, person.state, person.country].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Enrichment metadata stored in field.default_value
// ---------------------------------------------------------------------------

export type EnrichmentFieldMeta = {
	enrichment: {
		category: EnrichmentCategory;
		key: string;
		apolloPath: string;
		inputFieldName: string;
	};
};

export function buildEnrichmentMeta(
	category: EnrichmentCategory,
	colDef: EnrichmentColumnDef,
	inputFieldName: string,
): EnrichmentFieldMeta {
	return {
		enrichment: {
			category,
			key: colDef.key,
			apolloPath: colDef.apolloPath,
			inputFieldName,
		},
	};
}

export function parseEnrichmentMeta(
	defaultValue: string | null | undefined,
): EnrichmentFieldMeta | null {
	if (!defaultValue) return null;
	try {
		const parsed = JSON.parse(defaultValue);
		if (parsed?.enrichment?.category && parsed.enrichment.key) {
			return parsed as EnrichmentFieldMeta;
		}
	} catch { /* not enrichment metadata */ }
	return null;
}

/** Domain extraction from a URL or bare domain string. */
export function extractDomain(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "";
	try {
		const url = new URL(
			trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
		);
		return url.hostname.replace(/^www\./, "");
	} catch {
		return trimmed.replace(/^www\./, "");
	}
}

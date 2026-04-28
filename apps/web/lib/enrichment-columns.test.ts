import { describe, expect, it } from "vitest";
import {
	COMPANY_ENRICHMENT_COLUMNS,
	PEOPLE_ENRICHMENT_COLUMNS,
	extractEnrichmentValue,
	getAvailableEnrichmentCategories,
	getEligibleInputFields,
	getRequiredFieldsForApolloPath,
} from "./enrichment-columns";

describe("getEligibleInputFields", () => {
	it("limits people enrichment inputs to email and LinkedIn fields", () => {
		const fields = [
			{ id: "name", name: "Full Name", type: "text" },
			{ id: "email", name: "Email", type: "email" },
			{ id: "linkedin", name: "LinkedIn URL", type: "url" },
			{ id: "company", name: "Company", type: "text" },
		];

		expect(getEligibleInputFields("people", fields).map((field) => field.id)).toEqual([
			"email",
			"linkedin",
		]);
	});

	it("limits company enrichment inputs to domain, website, and LinkedIn fields", () => {
		const fields = [
			{ id: "name", name: "Company Name", type: "text" },
			{ id: "domain", name: "Domain", type: "text" },
			{ id: "website", name: "Website", type: "url" },
			{ id: "linkedin", name: "LinkedIn URL", type: "url" },
			{ id: "industry", name: "Industry", type: "text" },
		];

		expect(getEligibleInputFields("company", fields).map((field) => field.id)).toEqual([
			"domain",
			"website",
			"linkedin",
		]);
	});

	it("preserves object-name category detection for built-in people and company tables", () => {
		expect(getAvailableEnrichmentCategories("people", [])).toEqual(["people"]);
		expect(getAvailableEnrichmentCategories("companies", [])).toEqual(["company"]);
	});

	it("makes enrichment available on generic tables based on identifier columns", () => {
		expect(getAvailableEnrichmentCategories("investors", [
			{ id: "email", name: "Email", type: "email" },
		])).toEqual(["people"]);

		expect(getAvailableEnrichmentCategories("portfolio", [
			{ id: "domain", name: "Domain", type: "text" },
		])).toEqual(["company"]);
	});

	it("shows both enrichment categories on generic tables when LinkedIn is ambiguous or no identifiers exist yet", () => {
		expect(getAvailableEnrichmentCategories("pipeline", [
			{ id: "linkedin", name: "LinkedIn URL", type: "url" },
		])).toEqual(["people", "company"]);

		expect(getAvailableEnrichmentCategories("custom_table", [
			{ id: "notes", name: "Notes", type: "text" },
		])).toEqual(["people", "company"]);
	});
});

describe("requiredFields mapping", () => {
	it("attaches a non-empty canonical requiredFields list to every column", () => {
		for (const column of [...PEOPLE_ENRICHMENT_COLUMNS, ...COMPANY_ENRICHMENT_COLUMNS]) {
			expect(column.requiredFields.length).toBeGreaterThan(0);
		}
	});

	it("resolves canonical requiredFields from an apolloPath", () => {
		expect(getRequiredFieldsForApolloPath("people", "person.contact.phone_numbers.0.sanitized_number"))
			.toEqual(["phone"]);
		expect(getRequiredFieldsForApolloPath("people", "person.headline")).toEqual(["headline"]);
		expect(getRequiredFieldsForApolloPath("company", "organization.industry")).toEqual(["industryList"]);
		expect(getRequiredFieldsForApolloPath("company", "organization.website_url")).toEqual(["website"]);
	});

	it("returns an empty list for unknown apolloPaths so the gateway uses default backfill", () => {
		expect(getRequiredFieldsForApolloPath("people", "person.unknown")).toEqual([]);
	});
});

describe("extractEnrichmentValue", () => {
	const phoneColumn = PEOPLE_ENRICHMENT_COLUMNS.find((column) => column.label === "Phone");

	it("prefers the legacy Apollo path when both shapes are present", () => {
		const payload = {
			person: { contact: { phone_numbers: [{ sanitized_number: "+1234" }] } },
			phone: "+9999",
		};
		expect(extractEnrichmentValue(payload, phoneColumn!)).toBe("+1234");
	});

	it("falls back to the canonical top-level field when the legacy path is missing", () => {
		const payload = { phone: "+9999" };
		expect(extractEnrichmentValue(payload, phoneColumn!)).toBe("+9999");
	});

	it("returns null when no path resolves", () => {
		expect(extractEnrichmentValue({}, phoneColumn!)).toBeNull();
	});
});

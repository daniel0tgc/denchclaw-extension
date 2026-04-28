import { describe, expect, it } from "vitest";
import { getAvailableEnrichmentCategories, getEligibleInputFields } from "./enrichment-columns";

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

		expect(getAvailableEnrichmentCategories("accounts_list", [
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

import { describe, expect, it } from "vitest";
import { getEligibleInputFields } from "./enrichment-columns";

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
});

// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddColumnPopover } from "./column-header-menu";

describe("AddColumnPopover", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "/api/workspace/enrichment-status") {
				return new Response(JSON.stringify({ available: true }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;
	});

	it("refreshes enrichment input options when fields change for the same object", async () => {
		const user = userEvent.setup();
		const fields = [{ id: "field_name", name: "Name", type: "text" }];
		const { rerender } = render(
			<AddColumnPopover
				objectName="leads"
				fields={fields}
				enrichmentAvailable
				onCreated={() => {}}
			/>,
		);

		await user.click(screen.getByTitle("Add column"));
		await user.click(await screen.findByRole("button", { name: "Full Name" }));

		const inputSelect = screen.getByRole("combobox") as HTMLSelectElement;
		expect(inputSelect).toHaveValue("");
		expect(screen.queryByRole("option", { name: "Email" })).not.toBeInTheDocument();

		rerender(
			<AddColumnPopover
				objectName="leads"
				fields={[...fields, { id: "field_email", name: "Email", type: "email" }]}
				enrichmentAvailable
				onCreated={() => {}}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("option", { name: "Email" })).toBeInTheDocument();
		});
		expect(inputSelect).toHaveValue("Email");
		expect(screen.getByText(/Will enrich using.*Email.*column/)).toBeInTheDocument();
	});
});

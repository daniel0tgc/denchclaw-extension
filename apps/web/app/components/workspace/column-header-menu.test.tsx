// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddColumnPopover, SelectOptionsEditor } from "./column-header-menu";

describe("AddColumnPopover", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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

		const inputSelect = screen.getByRole("combobox");
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

	it("does not render the old column-name search field in the add-column popover", async () => {
		const user = userEvent.setup();
		render(
			<AddColumnPopover
				objectName="leads"
				fields={[]}
				enrichmentAvailable={false}
				onCreated={() => {}}
			/>,
		);

		await user.click(screen.getByTitle("Add column"));

		expect(screen.queryByPlaceholderText("Column name...")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
	});
});

describe("SelectOptionsEditor", () => {
	it("lets select fields add, edit, and remove options from the header menu", async () => {
		const user = userEvent.setup();
		const onOptionsUpdate = vi.fn(async () => {});

		render(
			<SelectOptionsEditor
				values={["Lead", "Customer"]}
				onSave={onOptionsUpdate}
			/>,
		);

		expect(await screen.findByText("Options")).toBeInTheDocument();

		await user.type(screen.getByPlaceholderText("Add option..."), "Qualified");
		await user.click(screen.getByRole("button", { name: "Add option" }));
		expect(onOptionsUpdate).toHaveBeenLastCalledWith(["Lead", "Customer", "Qualified"]);

		const leadInput = screen.getByLabelText("Edit option Lead");
		fireEvent.change(leadInput, { target: { value: "Prospect" } });
		fireEvent.click(screen.getByRole("button", { name: "Save option Prospect" }));
		await waitFor(() => {
			expect(onOptionsUpdate).toHaveBeenLastCalledWith(["Prospect", "Customer", "Qualified"]);
		});

		await user.click(screen.getByRole("button", { name: "Remove option Customer" }));
		expect(onOptionsUpdate).toHaveBeenLastCalledWith(["Prospect", "Qualified"]);
	});
});

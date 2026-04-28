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
		expect(screen.queryByText(/Will enrich using.*Email.*column/)).not.toBeInTheDocument();
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

	it("refreshes fields after reusing an existing enrichment output column", async () => {
		const user = userEvent.setup();
		const onCreated = vi.fn();
		const onEnrichmentStart = vi.fn();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/workspace/enrichment-status") {
				return new Response(JSON.stringify({ available: true }));
			}
			if (url === "/api/workspace/objects/leads/fields/field_full_name" && init?.method === "PATCH") {
				return new Response(JSON.stringify({ ok: true }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		global.fetch = fetchMock as typeof fetch;

		render(
			<AddColumnPopover
				objectName="leads"
				fields={[
					{ id: "field_email", name: "Email", type: "email" },
					{ id: "field_full_name", name: "Full Name", type: "text" },
				]}
				enrichmentAvailable
				onCreated={onCreated}
				onEnrichmentStart={onEnrichmentStart}
			/>,
		);

		await user.click(screen.getByTitle("Add column"));
		await user.click(await screen.findByRole("button", { name: "Full Name" }));
		await user.click(screen.getByRole("button", { name: "Enrich all" }));

		await waitFor(() => {
			expect(onCreated).toHaveBeenCalledTimes(1);
		});
		expect(onEnrichmentStart).toHaveBeenCalledWith(expect.objectContaining({
			fieldId: "field_full_name",
			fieldName: "Full Name",
			inputFieldName: "Email",
		}));
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

	it("does not double-save when an option input blurs before clicking save", async () => {
		let resolveSave: (() => void) | undefined;
		const onOptionsUpdate = vi.fn(() => new Promise<void>((resolve) => {
			resolveSave = resolve;
		}));

		render(
			<SelectOptionsEditor
				values={["Lead", "Customer"]}
				onSave={onOptionsUpdate}
			/>,
		);

		const leadInput = screen.getByLabelText("Edit option Lead");
		fireEvent.change(leadInput, { target: { value: "Prospect" } });
		fireEvent.blur(leadInput);
		fireEvent.click(screen.getByRole("button", { name: "Save option Prospect" }));

		expect(onOptionsUpdate).toHaveBeenCalledTimes(1);
		expect(onOptionsUpdate).toHaveBeenCalledWith(["Prospect", "Customer"]);
		resolveSave?.();
		await waitFor(() => {
			expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
		});
	});
});

// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectTable } from "./object-table";
import type { TableSelectionContext } from "@/lib/table-selection";

describe("ObjectTable selection context", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/workspace/enrichment-status") {
				return new Response(JSON.stringify({ available: false }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;
	});

	it("emits selected cell values for chat context", async () => {
		const onSelectionContextChange = vi.fn();
		render(
			<ObjectTable
				objectName="people"
				fields={[
					{ id: "name", name: "Name", type: "text" },
					{ id: "email", name: "Email", type: "email" },
				]}
				entries={[
					{ entry_id: "p1", Name: "Ada", Email: "ada@example.com" },
					{ entry_id: "p2", Name: "Grace", Email: "grace@example.com" },
				]}
				hideInternalToolbar
				onSelectionContextChange={onSelectionContextChange}
			/>,
		);

		fireEvent.mouseDown(screen.getByText("Ada").closest("td")!);

		await waitFor(() => {
			const lastCall = onSelectionContextChange.mock.lastCall?.[0] as TableSelectionContext | null;
			expect(lastCall).toMatchObject({
				objectName: "people",
				kind: "cells",
				rowCount: 1,
				columnCount: 1,
				columns: ["Name"],
				cells: [{ rowIndex: 0, entryId: "p1", fieldName: "Name", value: "Ada" }],
			});
		});
	});

	it("emits selected row values for chat context", async () => {
		const onSelectionContextChange = vi.fn();
		render(
			<ObjectTable
				objectName="people"
				fields={[
					{ id: "name", name: "Name", type: "text" },
					{ id: "email", name: "Email", type: "email" },
				]}
				entries={[
					{ entry_id: "p1", Name: "Ada", Email: "ada@example.com" },
					{ entry_id: "p2", Name: "Grace", Email: "grace@example.com" },
				]}
				hideInternalToolbar
				onSelectionContextChange={onSelectionContextChange}
			/>,
		);

		fireEvent.mouseDown(screen.getByText("2").closest("td")!);

		await waitFor(() => {
			const lastCall = onSelectionContextChange.mock.lastCall?.[0] as TableSelectionContext | null;
			expect(lastCall).toMatchObject({
				objectName: "people",
				kind: "rows",
				rowCount: 1,
				columns: expect.arrayContaining(["Name", "Email"]),
				rows: [{
					rowIndex: 1,
					entryId: "p2",
					values: expect.objectContaining({
						Name: "Grace",
						Email: "grace@example.com",
					}),
				}],
			});
		});
	});
});

// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./data-table";

type Row = {
	id: string;
	name: string;
	email: string;
};

const rows: Row[] = [
	{ id: "1", name: "Ada", email: "ada@example.com" },
	{ id: "2", name: "Grace", email: "grace@example.com" },
];

const columns: ColumnDef<Row>[] = [
	{ id: "name", accessorKey: "name", header: "Name" },
	{ id: "email", accessorKey: "email", header: "Email" },
];

describe("DataTable cell selection", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("selects cells and moves the active cell with arrow keys", () => {
		const onCellSelectionChange = vi.fn();
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableCellSelection
				onCellSelectionChange={onCellSelectionChange}
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		const firstCell = screen.getByText("Ada").closest("td");
		expect(firstCell).not.toBeNull();
		fireEvent.mouseDown(firstCell!);

		expect(onCellSelectionChange).toHaveBeenLastCalledWith({
			anchor: { rowIndex: 0, columnId: "name" },
			focus: { rowIndex: 0, columnId: "name" },
		});
		expect(firstCell).toHaveAttribute("aria-selected", "true");

		const tableScroller = firstCell!.closest("div[tabindex='0']");
		expect(tableScroller).not.toBeNull();
		fireEvent.keyDown(tableScroller!, { key: "ArrowRight" });

		expect(onCellSelectionChange).toHaveBeenLastCalledWith({
			anchor: { rowIndex: 0, columnId: "email" },
			focus: { rowIndex: 0, columnId: "email" },
		});
		expect(screen.getByText("ada@example.com").closest("td")).toHaveAttribute("data-dt-cell-active", "true");
	});

	it("extends a selected range with shift-arrow navigation", () => {
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableCellSelection
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		const firstCell = screen.getByText("Ada").closest("td");
		fireEvent.mouseDown(firstCell!);
		const tableScroller = firstCell!.closest("div[tabindex='0']");
		fireEvent.keyDown(tableScroller!, { key: "ArrowRight" });
		fireEvent.keyDown(tableScroller!, { key: "ArrowDown", shiftKey: true });

		expect(screen.getByText("ada@example.com").closest("td")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("grace@example.com").closest("td")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Grace").closest("td")).not.toHaveAttribute("aria-selected");
	});

	it("uses row numbers as row-selection handles", () => {
		render(
			<DataTable
				columns={columns}
				data={rows}
				enableRowSelection
				hideToolbar
				getRowId={(row) => row.id}
			/>,
		);

		const rowNumberCell = screen.getByText("1").closest("td");
		fireEvent.mouseDown(rowNumberCell!);

		const firstRowCheckbox = screen.getAllByRole("checkbox")[1] as HTMLInputElement;
		expect(firstRowCheckbox.checked).toBe(true);
	});
});

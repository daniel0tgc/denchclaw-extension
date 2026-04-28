import { describe, expect, it } from "vitest";
import { formatTableSelectionContext, tableSelectionFingerprint, type TableSelectionContext } from "./table-selection";

describe("table selection context", () => {
	it("formats selected cells for chat context", () => {
		const selection: TableSelectionContext = {
			objectName: "people",
			kind: "cells",
			rowCount: 1,
			columnCount: 2,
			columns: ["Name", "Email"],
			cells: [
				{ rowIndex: 0, entryId: "p1", fieldName: "Name", value: "Ada" },
				{ rowIndex: 0, entryId: "p1", fieldName: "Email", value: "ada@example.com" },
			],
			updatedAt: 1,
		};

		expect(formatTableSelectionContext(selection)).toContain("[Selected table cells: people]");
		expect(formatTableSelectionContext(selection)).toContain("row 1 (p1), Email: ada@example.com");
	});

	it("fingerprints selection by contents, not timestamp", () => {
		const base: TableSelectionContext = {
			objectName: "company",
			kind: "rows",
			rowCount: 1,
			columnCount: 1,
			columns: ["Name"],
			rows: [{ rowIndex: 0, entryId: "c1", values: { Name: "Acme" } }],
			updatedAt: 1,
		};

		expect(tableSelectionFingerprint(base)).toBe(
			tableSelectionFingerprint({ ...base, updatedAt: 2 }),
		);
	});
});

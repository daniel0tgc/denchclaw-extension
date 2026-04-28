export type TableSelectionPoint = {
	rowIndex: number;
	columnId: string;
};

export type TableCellSelectionState = {
	anchor: TableSelectionPoint;
	focus: TableSelectionPoint;
};

export type TableSelectionCellSnapshot = {
	rowIndex: number;
	entryId: string;
	fieldName: string;
	value: string;
};

export type TableSelectionRowSnapshot = {
	rowIndex: number;
	entryId: string;
	values: Record<string, string>;
};

export type TableSelectionContext = {
	objectName: string;
	kind: "cells" | "rows";
	rowCount: number;
	columnCount: number;
	columns: string[];
	cells?: TableSelectionCellSnapshot[];
	rows?: TableSelectionRowSnapshot[];
	updatedAt: number;
};

export function tableSelectionFingerprint(selection: TableSelectionContext | null | undefined): string {
	if (!selection) {
		return "";
	}
	const cellKey = selection.cells
		?.map((cell) => `${cell.entryId}:${cell.fieldName}:${cell.value}`)
		.join("|") ?? "";
	const rowKey = selection.rows
		?.map((row) => `${row.entryId}:${Object.entries(row.values).map(([key, value]) => `${key}:${value}`).join(",")}`)
		.join("|") ?? "";
	return [
		selection.objectName,
		selection.kind,
		selection.rowCount,
		selection.columnCount,
		selection.columns.join(","),
		cellKey,
		rowKey,
	].join("::");
}

export function formatTableSelectionContext(selection: TableSelectionContext): string {
	if (selection.kind === "rows") {
		const rows = selection.rows ?? [];
		const preview = rows.slice(0, 10).map((row) => {
			const values = selection.columns
				.map((column) => `${column}: ${row.values[column] ?? ""}`)
				.join("; ");
			return `- row ${row.rowIndex + 1} (${row.entryId}): ${values}`;
		});
		const suffix = rows.length > preview.length ? `\n- ...${rows.length - preview.length} more selected rows` : "";
		return [
			`[Selected table rows: ${selection.objectName}]`,
			`${selection.rowCount} row${selection.rowCount === 1 ? "" : "s"} selected.`,
			`Columns: ${selection.columns.join(", ")}`,
			...preview,
		].join("\n") + suffix;
	}

	const cells = selection.cells ?? [];
	const preview = cells.slice(0, 30).map((cell) =>
		`- row ${cell.rowIndex + 1} (${cell.entryId}), ${cell.fieldName}: ${cell.value}`,
	);
	const suffix = cells.length > preview.length ? `\n- ...${cells.length - preview.length} more selected cells` : "";
	return [
		`[Selected table cells: ${selection.objectName}]`,
		`${selection.rowCount} row${selection.rowCount === 1 ? "" : "s"} x ${selection.columnCount} column${selection.columnCount === 1 ? "" : "s"} selected.`,
		`Columns: ${selection.columns.join(", ")}`,
		...preview,
	].join("\n") + suffix;
}

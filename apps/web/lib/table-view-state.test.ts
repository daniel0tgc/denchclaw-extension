// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { loadTableViewState, saveTableViewState } from "./table-view-state";

describe("table view state persistence", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("removes storage when all saved view customizations return to defaults", () => {
		saveTableViewState("people", {
			view: "Recent leads",
			search: "ada",
		});
		expect(loadTableViewState("people")).toMatchObject({
			view: "Recent leads",
			search: "ada",
		});

		saveTableViewState("people", {});

		expect(loadTableViewState("people")).toEqual({});
	});
});

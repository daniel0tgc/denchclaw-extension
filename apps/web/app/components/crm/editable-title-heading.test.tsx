// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditableTitleHeading } from "./editable-title-heading";

describe("EditableTitleHeading", () => {
	it("guards against Enter and blur issuing duplicate saves", async () => {
		const user = userEvent.setup();
		let resolveSave: (() => void) | undefined;
		const saveName = vi.fn(() => new Promise<void>((resolve) => {
			resolveSave = resolve;
		}));

		render(<EditableTitleHeading name="" saveName={saveName} />);

		await user.click(screen.getByRole("button", { name: "Add a name" }));
		const input = screen.getByRole("textbox", { name: "Name" });
		await user.type(input, "Ada Lovelace");

		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.blur(input);

		expect(saveName).toHaveBeenCalledTimes(1);
		expect(saveName).toHaveBeenCalledWith("Ada Lovelace");
		resolveSave?.();
	});
});

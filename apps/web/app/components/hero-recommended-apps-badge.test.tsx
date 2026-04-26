// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeroRecommendedAppsBadge } from "./hero-recommended-apps-badge";

describe("HeroRecommendedAppsBadge", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({ connections: [], toolkits: [] }),
		})));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders when there are no connected Composio apps", async () => {
		render(<HeroRecommendedAppsBadge />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Connect recommended apps" })).toBeInTheDocument();
		});
	});

	it("hides when at least one active Composio app is connected", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({
				connections: [{
					id: "conn-1",
					toolkit_slug: "slack",
					toolkit_name: "Slack",
					status: "ACTIVE",
					created_at: "2026-01-01T00:00:00.000Z",
					toolkit: {
						slug: "slack",
						name: "Slack",
					},
				}],
				toolkits: [],
			}),
		})));

		render(<HeroRecommendedAppsBadge />);

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Connect recommended apps" })).not.toBeInTheDocument();
		});
	});

	it("navigates to integrations when clicked", async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();

		render(<HeroRecommendedAppsBadge onNavigate={onNavigate} />);

		await user.click(await screen.findByRole("button", { name: "Connect recommended apps" }));

		expect(onNavigate).toHaveBeenCalledTimes(1);
	});
});

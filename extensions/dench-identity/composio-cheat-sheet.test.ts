import { describe, expect, it } from "vitest";
import { formatComposioToolCheatSheetFromIndex } from "./composio-cheat-sheet.js";

describe("formatComposioToolCheatSheetFromIndex", () => {
  it("renders markdown with tool table and gotchas", () => {
    const md = formatComposioToolCheatSheetFromIndex({
      generated_at: "2025-01-01T00:00:00.000Z",
      connected_apps: [
        {
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          account_count: 2,
          accounts: [
            {
              connected_account_id: "conn_gmail_1",
              account_identity: "gmail:work",
              account_identity_source: "gateway_stable_id",
              identity_confidence: "high",
              display_label: "Work Gmail",
              account_email: "work@example.com",
              related_connection_ids: [],
              is_same_account_reconnect: false,
            },
          ],
          tools: [
            {
              name: "GMAIL_FETCH_EMAILS",
              title: "Fetch emails",
              description_short: "List messages.",
              required_args: [],
              arg_hints: {
                label_ids: 'Use ["INBOX"]',
              },
            },
          ],
          recipes: {
            "Read recent emails": "GMAIL_FETCH_EMAILS",
          },
        },
      ],
    });

    expect(md).toContain("### Gmail (2 accounts connected)");
    expect(md).toContain("GMAIL_FETCH_EMAILS");
    expect(md).toContain("Read recent emails");
    expect(md).toContain("label_ids");
    expect(md).toContain("Dench Integrations");
    expect(md).not.toContain("Composio MCP");
    expect(md).toContain("composio_search_tools");
    expect(md).toContain("composio_call_tool");
    expect(md).toContain("Work Gmail");
    expect(md).toContain("configured integration layer");
  });
});

import { describe, expect, it } from "vitest";
import {
  extractComposioConnections,
  normalizeComposioConnection,
} from "./composio-client";

describe("extractComposioConnections", () => {
  it("prefers enriched gateway connections and stable account identity", () => {
    const connections = extractComposioConnections({
      connections: [
        {
          id: "conn_1",
          toolkit: {
            slug: "gmail",
            name: "Gmail",
          },
          status: "ACTIVE",
          createdAt: "2026-04-01T00:00:00.000Z",
          account: {
            stableId: "cmpacct_gmail_work",
            confidence: "high",
            label: "Work Gmail",
            email: "work@example.com",
            rawIds: {
              providerAccountId: "gmail_account_123",
            },
          },
          reconnect: {
            claim: "same",
            confidence: "high",
            relatedConnectionIds: ["conn_0"],
          },
        },
      ],
    });

    expect(connections).toEqual([
      expect.objectContaining({
        id: "conn_1",
        toolkit_slug: "gmail",
        toolkit_name: "Gmail",
        created_at: "2026-04-01T00:00:00.000Z",
        account_label: "Work Gmail",
        account_email: "work@example.com",
        external_account_id: "gmail_account_123",
        account_stable_id: "cmpacct_gmail_work",
      }),
    ]);

    const normalized = normalizeComposioConnection(connections[0]!);
    expect(normalized.account_identity).toBe("cmpacct_gmail_work");
    expect(normalized.account_identity_source).toBe("gateway_stable_id");
    expect(normalized.identity_confidence).toBe("high");
    expect(normalized.reconnect_claim).toBe("same");
    expect(normalized.related_connection_ids).toEqual(["conn_0"]);
  });

  it("remains backward-compatible with legacy items payloads", () => {
    const connections = extractComposioConnections({
      items: [
        {
          id: "legacy_1",
          toolkit_slug: "github",
          toolkit_name: "GitHub",
          status: "ACTIVE",
          created_at: "2026-04-01T00:00:00.000Z",
          external_account_id: "acct_legacy",
          account_label: "Legacy GitHub",
        },
      ],
    });

    const normalized = normalizeComposioConnection(connections[0]!);
    expect(normalized.account_identity).toBe("github:acct_legacy");
    expect(normalized.account_identity_source).toBe("legacy_heuristic");
    expect(normalized.identity_confidence).toBe("high");
    expect(normalized.reconnect_claim).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import {
  createStreamParser,
  getChatDistanceFromBottom,
  isChatScrolledAwayFromBottom,
  scrollChatToBottom,
} from "./chat-panel";

describe("createStreamParser", () => {
  it("treats user-message as turn boundary and keeps user/assistant sequence stable", () => {
    const parser = createStreamParser();

    parser.processEvent({ type: "user-message", id: "u-1", text: "Draft an email" });
    parser.processEvent({ type: "text-start" });
    parser.processEvent({ type: "text-delta", delta: "Sure — drafting now." });
    parser.processEvent({ type: "text-end" });
    parser.processEvent({ type: "user-message", id: "u-2", text: "Also include follow-up" });
    parser.processEvent({ type: "text-start" });
    parser.processEvent({ type: "text-delta", delta: "Added a follow-up section." });
    parser.processEvent({ type: "text-end" });

    expect(parser.getParts()).toEqual([
      { type: "user-message", id: "u-1", text: "Draft an email" },
      { type: "text", text: "Sure — drafting now." },
      { type: "user-message", id: "u-2", text: "Also include follow-up" },
      { type: "text", text: "Added a follow-up section." },
    ]);
  });

  it("accumulates tool input/output by toolCallId and preserves terminal status", () => {
    const parser = createStreamParser();

    parser.processEvent({
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "searchDocs",
    });
    parser.processEvent({
      type: "tool-input-available",
      toolCallId: "tool-1",
      input: { query: "workspace lock" },
    });
    parser.processEvent({
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { hits: 3 },
    });

    parser.processEvent({
      type: "tool-input-start",
      toolCallId: "tool-2",
      toolName: "writeFile",
    });
    parser.processEvent({
      type: "tool-output-error",
      toolCallId: "tool-2",
      errorText: "permission denied",
    });

    expect(parser.getParts()).toEqual([
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "searchDocs",
        state: "output-available",
        input: { query: "workspace lock" },
        output: { hits: 3 },
      },
      {
        type: "dynamic-tool",
        toolCallId: "tool-2",
        toolName: "writeFile",
        state: "error",
        input: {},
        output: { error: "permission denied" },
      },
    ]);
  });

  it("keeps partial tool output visible without marking the tool complete", () => {
    const parser = createStreamParser();

    parser.processEvent({
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "readFile",
    });
    parser.processEvent({
      type: "tool-output-partial",
      toolCallId: "tool-1",
      output: { text: "first chunk" },
    });

    expect(parser.getParts()).toEqual([
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "readFile",
        state: "input-available",
        input: {},
        output: { text: "first chunk" },
        preliminary: true,
      },
    ]);
  });

  it("closes reasoning state on reasoning-end to prevent stuck streaming badges", () => {
    const parser = createStreamParser();

    parser.processEvent({ type: "reasoning-start" });
    parser.processEvent({ type: "reasoning-delta", delta: "Planning edits..." });
    parser.processEvent({ type: "reasoning-end" });

    expect(parser.getParts()).toEqual([
      { type: "reasoning", text: "Planning edits..." },
    ]);
  });

  it("ignores unknown events without corrupting previously parsed parts", () => {
    const parser = createStreamParser();

    parser.processEvent({ type: "text-start" });
    parser.processEvent({ type: "text-delta", delta: "Stable output" });
    parser.processEvent({ type: "unrecognized-event", payload: "noise" });
    parser.processEvent({ type: "text-end" });

    expect(parser.getParts()).toEqual([{ type: "text", text: "Stable output" }]);
  });
});

describe("chat scroll helpers", () => {
  it("treats reserved bottom padding as still away from the true bottom", () => {
    const metrics = { clientHeight: 600, scrollHeight: 1400, scrollTop: 660 };

    expect(getChatDistanceFromBottom(metrics)).toBe(140);
    expect(isChatScrolledAwayFromBottom(metrics)).toBe(true);
  });

  it("scrolls the chat container itself to the real bottom", () => {
    const calls: ScrollToOptions[] = [];
    const el = {
      scrollHeight: 1400,
      scrollTo: (options: ScrollToOptions) => calls.push(options),
    };

    scrollChatToBottom(el, "auto");

    expect(calls).toEqual([{ top: 1400, behavior: "auto" }]);
  });

  // ── Regression: layout drift under a pinned user ──
  // The bug: when the user was at the bottom, async layout changes (cloud
  // settings fetch ≈1–2 s, lazy ReportCard, voice button mount on cloud
  // refresh, web font load, status row toggle) grew or shrank the scroll
  // content WITHOUT touching the `messages` array. The old auto-scroll
  // listened only on `[messages]`, so the user drifted away from bottom and
  // perceived a small upward jump after 1–2 s of sitting still.
  //
  // The fix re-pins on every content-size change via ResizeObserver. These
  // tests pin the scroll-position contract that the new code must honor.

  it("detects user has drifted off bottom when content grows but scrollTop doesn't", () => {
    // User was at bottom (distance = 0) before any layout change.
    const before = { clientHeight: 600, scrollHeight: 1400, scrollTop: 800 };
    expect(isChatScrolledAwayFromBottom(before)).toBe(false);

    // Cloud-settings fetch resolves; voice-button row mounts in the last
    // assistant message. Content grows by 100 px, scrollTop unchanged.
    const afterGrow = { clientHeight: 600, scrollHeight: 1500, scrollTop: 800 };
    expect(getChatDistanceFromBottom(afterGrow)).toBe(100);
    expect(isChatScrolledAwayFromBottom(afterGrow)).toBe(true);

    // After re-pinning to the new scrollHeight, distance returns to 0.
    const afterRepin = { clientHeight: 600, scrollHeight: 1500, scrollTop: 900 };
    expect(isChatScrolledAwayFromBottom(afterRepin)).toBe(false);
  });

  it("tolerates browser scrollTop clamping when content shrinks", () => {
    // User was at bottom of scrollHeight = 1500 (scrollTop = 900).
    const before = { clientHeight: 600, scrollHeight: 1500, scrollTop: 900 };
    expect(isChatScrolledAwayFromBottom(before)).toBe(false);

    // Status row unmounts (e.g. `isStreaming` flipped false). Content
    // shrinks by 50 px; the browser clamps scrollTop to (scrollHeight -
    // clientHeight) = 850. The viewport is now back at the true bottom.
    const afterShrink = { clientHeight: 600, scrollHeight: 1450, scrollTop: 850 };
    expect(getChatDistanceFromBottom(afterShrink)).toBe(0);
    expect(isChatScrolledAwayFromBottom(afterShrink)).toBe(false);
  });

  it("scrollChatToBottom always targets scrollHeight, even after async growth", () => {
    // Simulate the real sequence of bytes hitting the DOM during a 200 ms
    // window: ReportCard placeholder → real chart → voice button mount.
    const calls: number[] = [];
    let scrollHeight = 1400;
    const el = {
      get scrollHeight() {
        return scrollHeight;
      },
      scrollTo: (options: ScrollToOptions) => {
        calls.push(options.top as number);
      },
    };

    scrollChatToBottom(el, "auto");
    scrollHeight = 1500; // chart hydrated
    scrollChatToBottom(el, "auto");
    scrollHeight = 1532; // voice button row mounted
    scrollChatToBottom(el, "auto");

    expect(calls).toEqual([1400, 1500, 1532]);
  });
});

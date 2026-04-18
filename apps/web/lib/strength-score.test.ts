import { describe, expect, it } from "vitest";
import {
  RECENCY_DECAY_TAU_DAYS,
  SCORE_WEIGHTS,
  emailDirectness,
  meetingDirectness,
  meetingTypeWeight,
  recencyDecay,
  roundScore,
  scoreEmailInteraction,
  scoreMeetingInteraction,
} from "./strength-score";

describe("recencyDecay", () => {
  it("returns 1 for ageDays = 0", () => {
    expect(recencyDecay(0)).toBeCloseTo(1, 5);
  });

  it("approximately halves at the half-life (~62 days)", () => {
    // exp(-62/90) ≈ 0.5004
    expect(recencyDecay(62)).toBeCloseTo(0.5, 1);
  });

  it("approaches 0 for old interactions", () => {
    expect(recencyDecay(365)).toBeLessThan(0.025);
    expect(recencyDecay(1000)).toBeLessThan(0.0001);
  });

  it("clamps negative ages to 1 (treated as today)", () => {
    expect(recencyDecay(-5)).toBe(1);
    expect(recencyDecay(NaN)).toBe(1);
  });
});

describe("emailDirectness", () => {
  it("matches the Attio-derived weights", () => {
    expect(emailDirectness("from")).toBe(1.0);
    expect(emailDirectness("to")).toBe(1.0);
    expect(emailDirectness("cc")).toBe(0.3);
    expect(emailDirectness("bcc")).toBe(0.1);
  });
});

describe("meetingDirectness", () => {
  it("ranks organizer above attendee", () => {
    expect(meetingDirectness("organizer", "accepted")).toBeGreaterThan(
      meetingDirectness("attendee", "accepted"),
    );
  });
  it("declined attendees contribute zero", () => {
    expect(meetingDirectness("attendee", "declined")).toBe(0);
  });
  it("treats needsAction the same as accepted (Google's default)", () => {
    expect(meetingDirectness("attendee", "needsAction")).toBe(
      meetingDirectness("attendee", "accepted"),
    );
  });
});

describe("meetingTypeWeight", () => {
  it("1:1 meetings dominate", () => {
    expect(meetingTypeWeight(2)).toBe(SCORE_WEIGHTS.oneOnOneMeeting);
    expect(meetingTypeWeight(1)).toBe(SCORE_WEIGHTS.oneOnOneMeeting);
  });
  it("small group is between 1:1 and large group", () => {
    expect(meetingTypeWeight(4)).toBe(SCORE_WEIGHTS.smallGroupMeeting);
    expect(meetingTypeWeight(5)).toBe(SCORE_WEIGHTS.smallGroupMeeting);
  });
  it("large groups are heavily de-weighted", () => {
    expect(meetingTypeWeight(10)).toBe(SCORE_WEIGHTS.largeGroupMeeting);
    expect(meetingTypeWeight(50)).toBe(SCORE_WEIGHTS.largeGroupMeeting);
  });
});

describe("scoreEmailInteraction", () => {
  it("today's direct email scores ~1", () => {
    expect(scoreEmailInteraction({ ageDays: 0, role: "to" })).toBeCloseTo(1, 5);
  });

  it("decays an old direct email", () => {
    const oneYear = scoreEmailInteraction({ ageDays: 365, role: "to" });
    const today = scoreEmailInteraction({ ageDays: 0, role: "to" });
    expect(oneYear).toBeLessThan(today * 0.05);
  });

  it("Cc gets fractional credit vs. To", () => {
    const cc = scoreEmailInteraction({ ageDays: 0, role: "cc" });
    const to = scoreEmailInteraction({ ageDays: 0, role: "to" });
    expect(cc).toBeCloseTo(0.3, 5);
    expect(cc / to).toBeCloseTo(0.3, 5);
  });

  it("two-way thread gives a +20% bump", () => {
    const base = scoreEmailInteraction({ ageDays: 0, role: "to" });
    const twoWay = scoreEmailInteraction({ ageDays: 0, role: "to", twoWayThread: true });
    expect(twoWay / base).toBeCloseTo(1.2, 3);
  });

  it("stacks bonuses multiplicatively", () => {
    const base = scoreEmailInteraction({ ageDays: 0, role: "to" });
    const stacked = scoreEmailInteraction({
      ageDays: 0,
      role: "to",
      twoWayThread: true,
      threadInitiator: true,
      fastReply: true,
    });
    // 1.2 * 1.1 * 1.1 ≈ 1.452
    expect(stacked / base).toBeCloseTo(1.452, 3);
  });
});

describe("scoreMeetingInteraction", () => {
  it("a recent 1:1 meeting outweighs many emails", () => {
    const meeting = scoreMeetingInteraction({
      ageDays: 0,
      attendeeCount: 2,
      role: "attendee",
      response: "accepted",
    });
    const email = scoreEmailInteraction({ ageDays: 0, role: "to" });
    expect(meeting / email).toBeGreaterThan(7);
  });

  it("declined attendees add zero", () => {
    expect(
      scoreMeetingInteraction({
        ageDays: 0,
        attendeeCount: 2,
        role: "attendee",
        response: "declined",
      }),
    ).toBe(0);
  });

  it("organizer credit is higher than attendee credit for the same meeting", () => {
    const organizer = scoreMeetingInteraction({
      ageDays: 0,
      attendeeCount: 4,
      role: "organizer",
      response: "accepted",
    });
    const attendee = scoreMeetingInteraction({
      ageDays: 0,
      attendeeCount: 4,
      role: "attendee",
      response: "accepted",
    });
    expect(organizer).toBeGreaterThan(attendee);
  });

  it("decay still applies to meetings", () => {
    const recent = scoreMeetingInteraction({
      ageDays: 0,
      attendeeCount: 2,
      role: "organizer",
      response: "accepted",
    });
    const old = scoreMeetingInteraction({
      ageDays: 365,
      attendeeCount: 2,
      role: "organizer",
      response: "accepted",
    });
    expect(old / recent).toBeLessThan(0.05);
  });
});

describe("roundScore", () => {
  it("trims to 4 decimals", () => {
    expect(roundScore(1.234567)).toBe(1.2346);
    expect(roundScore(0)).toBe(0);
    expect(roundScore(NaN)).toBe(0);
    expect(roundScore(Infinity)).toBe(0);
  });
});

describe("RECENCY_DECAY_TAU_DAYS", () => {
  it("matches the documented 90-day τ", () => {
    expect(RECENCY_DECAY_TAU_DAYS).toBe(90);
  });
});

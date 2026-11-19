import { describe, it, expect } from "vitest";
import {
  parseNoteTime,
  businessMinutesBetween,
  chicagoDate,
  computeIntakeScorecard,
  isBusinessHours,
  parseIntakeNotes,
  parseKeyValues,
} from "../src/tools/intakeScorecard";

describe("businessMinutesBetween (Mon–Fri 08:00–17:00 Central)", () => {
  it("counts straight minutes inside one business day", () => {
    // Thu 2026-11-19 10:00 CST = 16:00Z
    expect(businessMinutesBetween("2026-11-19T16:00:00Z", "2026-11-19T16:07:00Z")).toBe(7);
  });
  it("skips the night: 9pm lead, called 8:05am next day = 5", () => {
    // Wed 21:00 CST = Thu 03:00Z; Thu 08:05 CST = 14:05Z
    expect(businessMinutesBetween("2026-11-19T03:00:00Z", "2026-11-19T14:05:00Z")).toBe(5);
  });
  it("skips the weekend: Fri 4:50pm to Mon 8:10am = 20", () => {
    // Fri 2026-11-20 16:50 CST = 22:50Z; Mon 11-23 08:10 CST = 14:10Z
    expect(businessMinutesBetween("2026-11-20T22:50:00Z", "2026-11-23T14:10:00Z")).toBe(20);
  });
  it("handles CDT (summer offset UTC-5)", () => {
    // Wed 2026-07-15 08:00 CDT = 13:00Z
    expect(businessMinutesBetween("2026-07-15T12:00:00Z", "2026-07-15T13:30:00Z")).toBe(30);
  });
  it("is zero when the contact precedes the lead", () => {
    expect(businessMinutesBetween("2026-11-19T17:00:00Z", "2026-11-19T16:00:00Z")).toBe(0);
  });
});

describe("Chicago calendar helpers", () => {
  it("dates an evening UTC instant to the Central day", () => {
    expect(chicagoDate("2026-11-20T03:30:00Z")).toBe("2026-11-19");
  });
  it("business hours exclude weekends and evenings", () => {
    expect(isBusinessHours("2026-11-19T16:00:00Z")).toBe(true); // Thu 10am
    expect(isBusinessHours("2026-11-20T00:00:00Z")).toBe(false); // Thu 6pm
    expect(isBusinessHours("2026-11-21T16:00:00Z")).toBe(false); // Sat
  });
});

describe("parseIntakeNotes", () => {
  it("parses key: value lines, case-insensitively", () => {
    expect(parseKeyValues("Received_At: 2026-11-19T10:00:00-06:00\nchannel: Phone")).toEqual({
      received_at: "2026-11-19T10:00:00-06:00",
      channel: "Phone",
    });
  });
  it("takes the earliest first contact and the latest disposition", () => {
    const p = parseIntakeNotes([
      { subject: "[First Contact]", body: "contacted_at: 2026-11-19T10:20:00-06:00", created_at: "2026-11-19T16:21:00Z" },
      { subject: "[Lead Received]", body: "received_at: 2026-11-19T10:00:00-06:00\nchannel: web\nsource: Internet", created_at: "2026-11-19T16:05:00Z" },
      { subject: "[First Contact]", body: "contacted_at: 2026-11-19T10:10:00-06:00\nmethod: phone\nby: Intake", created_at: "2026-11-19T16:11:00Z" },
      { subject: "[Disposition]", body: "outcome: no-response\nreason: three attempts", created_at: "2026-11-20T16:00:00Z" },
      { subject: "[Disposition]", body: "outcome: declined\nreason: fee", created_at: "2026-11-25T16:00:00Z" },
    ]);
    expect(p.received_at).toBe("2026-11-19T16:00:00.000Z");
    expect(p.contacted_at).toBe("2026-11-19T16:10:00.000Z");
    expect(p.channel).toBe("web");
    expect(p.source).toBe("Internet");
    expect(p.outcome).toBe("declined");
    expect(p.reason).toBe("fee");
  });
  it("falls back to the note's own created_at when the timestamp line is missing or bad", () => {
    const p = parseIntakeNotes([
      { subject: "[Lead Received]", body: "received_at: yesterday", created_at: "2026-11-19T16:00:00Z" },
    ]);
    expect(p.received_at).toBe("2026-11-19T16:00:00.000Z");
    expect(p.contacted_at).toBeNull();
  });
});

describe("computeIntakeScorecard", () => {
  const base = {
    updated_at: "2026-11-18T16:00:00Z",
    matter_assignee_ids: [1],
    client: { full_name: "X" },
  };
  const matters = [
    // Matured cohort (2026-08): hired, letter sent, hired 4 days later.
    { ...base, id: 1, created_at: "2026-08-03T15:00:00Z", status_category: "hired", status: "Hired", type: "Probate",
      first_letter_sent_date: "2026-08-04T15:00:00Z", hired_date: "2026-08-08" },
    { ...base, id: 2, created_at: "2026-08-10T15:00:00Z", status_category: "declined", status: "Didn't Pan Out", type: "Probate" },
    // Stale open matter in the matured cohort.
    { ...base, id: 3, created_at: "2026-08-12T15:00:00Z", updated_at: "2026-08-20T15:00:00Z", status_category: "intake", status: "Consultation Pending", type: "Estate Planning" },
    // Young cohort (2026-11).
    { ...base, id: 4, created_at: "2026-11-17T16:00:00Z", status_category: "intake", status: "In Progress", type: "Probate" },
  ];
  const notes = new Map([
    [1, [
      { subject: "[Lead Received]", body: "received_at: 2026-08-03T09:00:00-05:00\nchannel: phone\nsource: Referral", created_at: "2026-08-03T15:00:00Z" },
      { subject: "[First Contact]", body: "contacted_at: 2026-08-03T09:00:00-05:00", created_at: "2026-08-03T15:00:00Z" },
      { subject: "[Consult Booked]", body: "consult_at: 2026-08-04T10:00:00-05:00\nattorney: NRN", created_at: "2026-08-03T15:30:00Z" },
    ]],
    [2, [
      { subject: "[Lead Received]", body: "received_at: 2026-08-10T09:00:00-05:00\nchannel: web\nsource: Internet", created_at: "2026-08-10T15:00:00Z" },
      { subject: "[First Contact]", body: "contacted_at: 2026-08-10T09:40:00-05:00", created_at: "2026-08-10T15:00:00Z" },
      { subject: "[Disposition]", body: "outcome: declined\nreason: price", created_at: "2026-08-20T15:00:00Z" },
    ]],
    [3, []],
    [4, [
      { subject: "[Lead Received]", body: "received_at: 2026-11-17T10:00:00-06:00\nchannel: voicemail\nsource: Internet", created_at: "2026-11-17T16:00:00Z" },
    ]],
  ]);
  const card = computeIntakeScorecard(matters as any, notes, {
    asOf: "2026-11-19T18:00:00Z",
    maturityDays: 60,
    staleDays: 14,
    slaBusinessMinutes: 15,
    userNames: { 1: "Intake" },
  });

  it("measures speed to lead in business minutes against the SLA", () => {
    expect(card.speed_to_lead.all_business_minutes.n).toBe(2);
    expect(card.speed_to_lead.all_business_minutes.median).toBe(20);
    expect(card.speed_to_lead.within_sla).toEqual({ n: 1, of: 2, pct: 50 });
  });
  it("lists leads still awaiting first contact", () => {
    expect(card.speed_to_lead.awaiting_first_contact.map((r) => r.id)).toEqual([4]);
  });
  it("reports conversion only for matured cohorts", () => {
    const aug = card.conversion.cohorts.find((c) => c.cohort === "2026-08")!;
    const nov = card.conversion.cohorts.find((c) => c.cohort === "2026-11")!;
    expect(aug.matured).toBe(true);
    expect(aug.hire_rate_pct).toBeCloseTo(33.3, 1);
    expect(aug.hire_rate_of_decided_pct).toBe(50);
    expect(nov.matured).toBe(false);
    expect(nov.hire_rate_pct).toBeNull();
    expect(card.conversion.matured_cohorts.months).toEqual(["2026-08"]);
  });
  it("times the fee-agreement stages from Grow's own timestamps", () => {
    expect(card.stage_timing.grow_created_to_fee_agreement_sent_hours.median).toBe(24);
    expect(card.stage_timing.fee_agreement_sent_to_hired_days.median).toBe(4);
  });
  it("counts consults booked from the note and times lead to consult booked", () => {
    const aug = card.conversion.cohorts.find((c) => c.cohort === "2026-08")!;
    expect(aug.consult_booked).toBe(1);
    expect(card.stage_timing.lead_to_consult_booked_business_minutes).toMatchObject({ n: 1, median: 90 });
    expect(card.stage_timing.lead_to_fee_agreement_sent_business_minutes).toMatchObject({ n: 1, median: 600 });
  });
  it("uses a [Fee Agreement Sent] note when Grow has no letter date", () => {
    const c = computeIntakeScorecard(
      [{ id: 9, created_at: "2026-11-16T15:00:00Z", updated_at: "2026-11-18T15:00:00Z", status_category: "intake" }] as any,
      new Map([[9, [{ subject: "[Fee Agreement Sent]", body: "sent_at: 2026-11-17T09:00:00-06:00", created_at: "2026-11-17T15:05:00Z" }]]]),
      { asOf: "2026-11-19T18:00:00Z", maturityDays: 60, staleDays: 14, slaBusinessMinutes: 15 }
    );
    expect(c.stage_timing.grow_created_to_fee_agreement_sent_hours.median).toBe(24);
    expect(c.conversion.cohorts[0].fee_agreement_sent).toBe(1);
  });
  it("attributes source and loss reasons from the notes", () => {
    const internet = card.conversion.by_source.find((s) => s.key === "Internet")!;
    expect(internet).toMatchObject({ added: 2, hired: 0, declined: 1 });
    expect(card.conversion.loss_reasons).toEqual({ "declined: price": 1 });
  });
  it("flags stale open potentials and names coverage gaps instead of zeroing", () => {
    expect(card.hygiene.stale.map((s) => s.id)).toEqual([3]);
    expect(card.coverage.first_contact_logged).toEqual({ n: 2, of: 4, pct: 50 });
    expect(card.warnings.some((w) => w.includes("Speed to lead covers only 2 of 4"))).toBe(true);
  });
  it("never computes speed when notes were not read", () => {
    const c = computeIntakeScorecard(matters as any, new Map(), {
      asOf: "2026-11-19T18:00:00Z", maturityDays: 60, staleDays: 14, slaBusinessMinutes: 15,
    });
    expect(c.speed_to_lead.all_business_minutes.median).toBeNull();
    expect(c.warnings[0]).toMatch(/Notes were not read/);
  });
});

describe("parseNoteTime (what staff type into a Grow note)", () => {
  it("takes ISO with an offset as written", () => {
    expect(parseNoteTime("2026-11-19T10:32:00-06:00")).toBe("2026-11-19T16:32:00.000Z");
    expect(parseNoteTime("2026-11-19T16:32:00Z")).toBe("2026-11-19T16:32:00.000Z");
  });
  it("reads a time without an offset as Central (CST in November)", () => {
    expect(parseNoteTime("2026-11-19 10:32 AM")).toBe("2026-11-19T16:32:00.000Z");
    expect(parseNoteTime("2026-11-19 2:05 pm")).toBe("2026-11-19T20:05:00.000Z");
    expect(parseNoteTime("11/19/2026 10:32 AM")).toBe("2026-11-19T16:32:00.000Z");
    expect(parseNoteTime("2026-11-19T10:32")).toBe("2026-11-19T16:32:00.000Z");
    expect(parseNoteTime("2026-11-19 12:15 AM")).toBe("2026-11-19T06:15:00.000Z");
  });
  it("uses CDT in summer", () => {
    expect(parseNoteTime("2026-07-15 9:00 AM")).toBe("2026-07-15T14:00:00.000Z");
  });
  it("returns null for anything it cannot read, so the note's own time is used", () => {
    expect(parseNoteTime("this morning")).toBeNull();
    expect(parseNoteTime("2026-11-19 13:00 PM")).toBeNull();
    expect(parseNoteTime("10:32 AM")).toBeNull();
  });
});

describe("standard, goal and hard floor", () => {
  const m = (id: number, created: string) => ({
    id, created_at: created, updated_at: created, status_category: "intake", client: { full_name: `C${id}` },
  });
  const lead = (recv: string, contact?: string) => [
    { subject: "[Lead Received]", body: `received_at: ${recv}`, created_at: recv },
    ...(contact ? [{ subject: "[First Contact]", body: `contacted_at: ${contact}`, created_at: contact }] : []),
  ];
  // Thu 2026-11-19, CST. 10:00 = 16:00Z.
  const card = computeIntakeScorecard(
    [m(1, "2026-11-19T16:00:00Z"), m(2, "2026-11-19T16:00:00Z"), m(3, "2026-11-19T16:00:00Z"), m(4, "2026-11-19T15:00:00Z")] as any,
    new Map([
      [1, lead("2026-11-19T16:00:00Z", "2026-11-19T16:10:00Z")], // 10 min
      [2, lead("2026-11-19T16:00:00Z", "2026-11-19T16:25:00Z")], // 25 min
      [3, lead("2026-11-19T16:00:00Z", "2026-11-19T18:30:00Z")], // 150 min
      [4, lead("2026-11-19T15:00:00Z")], // 9:00, not reached, as of 12:00 = 180 min
    ]) as any,
    { asOf: "2026-11-19T18:00:00Z", maturityDays: 60, staleDays: 14, slaBusinessMinutes: 30, goalBusinessMinutes: 15, hardFloorBusinessMinutes: 120 }
  );
  it("reports the 30-minute standard and the 15-minute goal side by side", () => {
    expect(card.speed_to_lead.within_sla).toEqual({ n: 2, of: 3, pct: 66.7 });
    expect(card.speed_to_lead.within_goal).toEqual({ n: 1, of: 3, pct: 33.3 });
  });
  it("names every lead past the 2-hour floor, reached or not", () => {
    expect(card.speed_to_lead.past_hard_floor).toEqual([
      { id: 4, client: "C4", business_minutes: 180, contacted: false },
      { id: 3, client: "C3", business_minutes: 150, contacted: true },
    ]);
  });
});

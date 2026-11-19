import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { growFetchAllPages } from "../clio/grow";

// Intake scorecard: speed to lead, funnel stage timing, cohort conversion and
// pipeline hygiene, computed from Clio Grow.
//
// What Grow records on its own (measured 2026-11-19 on 478 matters created
// since 2025-11-01): created_at, hired_date (every hired matter),
// first_letter_sent_date (212 matters, the fee agreement / engagement letter
// sent from Grow), first_appointment_created_at (3 matters: consults are not
// booked in Grow) and status. What it does NOT record is when the lead arrived
// or when a person first reached the prospect: a Grow matter is created after
// the call, so created_at measures typing, not responsiveness. Clio offers no
// write scope for matters or contacts, so those two timestamps are captured as
// structured Grow notes written by the intake skill (rs-intake:intake-call):
//
//   subject "[Lead Received]"   body lines  received_at: <ISO-8601>
//                                           channel: phone|web|email|voicemail|referral|walk-in
//                                           source: <Grow source name>
//                                           referred_by: <name>          (optional)
//   subject "[First Contact]"   body lines  contacted_at: <ISO-8601>
//                                           method: <how>  by: <who>
//   subject "[Consult Booked]"  body lines  consult_at: <ISO-8601>  attorney: <initials>
//   subject "[Fee Agreement Sent]" body    sent_at: <ISO-8601>   (only when not sent from Grow)
//   subject "[Disposition]"     body lines  outcome: hired|declined|disqualified|no-response|referred-out
//                                           reason: <free text>
//
// A metric whose inputs are missing is reported with its coverage (n of N),
// never as a zero. A scorecard that reads "0 minutes" because nobody logged
// first contact is the failure this module exists to prevent.

export const INTAKE_NOTE_SUBJECTS = {
  leadReceived: "[Lead Received]",
  firstContact: "[First Contact]",
  consultBooked: "[Consult Booked]",
  feeAgreementSent: "[Fee Agreement Sent]",
  disposition: "[Disposition]",
} as const;

const TZ = "America/Chicago";
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 17;

export interface GrowNote {
  subject?: string | null;
  body?: string | null;
  created_at?: string | null;
}

export interface GrowMatterRow {
  id: number;
  description?: string | null;
  created_at: string;
  updated_at: string;
  hired_date?: string | null;
  first_letter_sent_date?: string | null;
  first_appointment_created_at?: string | null;
  status?: string | null;
  status_category?: string | null;
  type?: string | null;
  matter_assignee_ids?: number[] | null;
  projected_value?: number | null;
  client?: { full_name?: string | null } | null;
}

export interface ParsedIntakeNotes {
  received_at: string | null;
  channel: string | null;
  source: string | null;
  referred_by: string | null;
  contacted_at: string | null;
  contact_method: string | null;
  contacted_by: string | null;
  consult_booked_at: string | null;
  consult_at: string | null;
  fee_agreement_sent_at: string | null;
  outcome: string | null;
  reason: string | null;
}

/** Parse "key: value" lines from a note body (case-insensitive keys). */
export function parseKeyValues(body: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_ ]+?)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1].trim().toLowerCase().replace(/\s+/g, "_")] = m[2];
  }
  return out;
}

function validIso(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Extract the structured intake notes. When a subject appears more than once,
 * the EARLIEST note wins for lead-received and first-contact (a later
 * "[First Contact]" is a second contact, not the first) and the LATEST wins for
 * disposition (the outcome can change). A missing timestamp line falls back to
 * the note's own created_at, which Grow sets and the writer cannot backdate.
 */
export function parseIntakeNotes(notes: GrowNote[]): ParsedIntakeNotes {
  const sorted = [...notes].sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
  const pick = (subject: string, latest = false) => {
    const hits = sorted.filter((n) => (n.subject ?? "").trim().toLowerCase().startsWith(subject.toLowerCase()));
    return latest ? hits[hits.length - 1] : hits[0];
  };
  const lr = pick(INTAKE_NOTE_SUBJECTS.leadReceived);
  const fc = pick(INTAKE_NOTE_SUBJECTS.firstContact);
  const dp = pick(INTAKE_NOTE_SUBJECTS.disposition, true);
  const cb = pick(INTAKE_NOTE_SUBJECTS.consultBooked);
  const fa = pick(INTAKE_NOTE_SUBJECTS.feeAgreementSent);
  const cbkv = parseKeyValues(cb?.body);
  const fakv = parseKeyValues(fa?.body);
  const lrkv = parseKeyValues(lr?.body);
  const fckv = parseKeyValues(fc?.body);
  const dpkv = parseKeyValues(dp?.body);
  return {
    received_at: lr ? validIso(lrkv.received_at) ?? validIso(lr.created_at) : null,
    channel: lrkv.channel?.toLowerCase() ?? null,
    source: lrkv.source ?? null,
    referred_by: lrkv.referred_by ?? null,
    contacted_at: fc ? validIso(fckv.contacted_at) ?? validIso(fc.created_at) : null,
    contact_method: fckv.method ?? null,
    contacted_by: fckv.by ?? null,
    // When the consult was BOOKED is the note's own timestamp; when it is
    // scheduled FOR is the consult_at line.
    consult_booked_at: cb ? validIso(cb.created_at) : null,
    consult_at: cb ? validIso(cbkv.consult_at) : null,
    fee_agreement_sent_at: fa ? validIso(fakv.sent_at) ?? validIso(fa.created_at) : null,
    outcome: dpkv.outcome?.toLowerCase() ?? null,
    reason: dpkv.reason ?? null,
  };
}

/** Wall-clock parts of an instant in America/Chicago. */
function chicagoParts(ms: number) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    y: +p.year,
    mo: +p.month,
    d: +p.day,
    h: +p.hour % 24,
    mi: +p.minute,
    s: +p.second,
    weekday: p.weekday,
  };
}

/** UTC instant for a Chicago wall-clock time (DST-correct). */
function chicagoToUtc(y: number, mo: number, d: number, h: number): number {
  const guess = Date.UTC(y, mo - 1, d, h);
  const p = chicagoParts(guess);
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return guess - (asIfUtc - guess);
}

export function chicagoDate(iso: string): string {
  const p = chicagoParts(Date.parse(iso));
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function isBusinessHours(iso: string): boolean {
  const p = chicagoParts(Date.parse(iso));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  return p.h >= BUSINESS_START_HOUR && p.h < BUSINESS_END_HOUR;
}

/**
 * Business minutes between two instants (Mon–Fri 8:00–17:00 Central, no
 * holiday calendar). A lead that arrives at 9pm and is called at 8:05am is 5
 * business minutes, not 665 wall minutes: the SLA is a business-hours SLA, and
 * after-hours responsiveness is reported separately.
 */
export function businessMinutesBetween(fromIso: string, toIso: string): number {
  let a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!(b > a)) return 0;
  let total = 0;
  for (let guard = 0; guard < 400 && a < b; guard++) {
    const p = chicagoParts(a);
    const open = chicagoToUtc(p.y, p.mo, p.d, BUSINESS_START_HOUR);
    const close = chicagoToUtc(p.y, p.mo, p.d, BUSINESS_END_HOUR);
    const weekend = p.weekday === "Sat" || p.weekday === "Sun";
    if (!weekend) {
      const s = Math.max(a, open);
      const e = Math.min(b, close);
      if (e > s) total += e - s;
    }
    // Next Chicago midnight: noon tomorrow's date, then its 00:00.
    const next = chicagoParts(chicagoToUtc(p.y, p.mo, p.d, 12) + 24 * 3600 * 1000);
    a = chicagoToUtc(next.y, next.mo, next.d, 0);
  }
  return Math.round(total / 60000);
}

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (idx - lo)) * 10) / 10;
}

function dist(xs: number[]) {
  return { n: xs.length, median: quantile(xs, 0.5), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9) };
}

function pct(n: number, d: number): number | null {
  return d ? Math.round((n / d) * 1000) / 10 : null;
}

export interface ScorecardOptions {
  asOf: string;
  maturityDays: number;
  staleDays: number;
  slaBusinessMinutes: number;
  userNames?: Record<number, string>;
  /** Matter ids whose notes were read (notes absent for others ≠ "no notes"). */
  notesRead?: Set<number>;
  staleListLimit?: number;
}

const DAY = 24 * 3600 * 1000;

export function computeIntakeScorecard(
  matters: GrowMatterRow[],
  notesByMatter: Map<number, GrowNote[]>,
  opts: ScorecardOptions
) {
  const asOfMs = Date.parse(opts.asOf);
  const name = (id: number) => opts.userNames?.[id] ?? String(id);
  const notesRead = opts.notesRead ?? new Set(notesByMatter.keys());

  // ---- speed to lead ---------------------------------------------------
  const speedBiz: number[] = [];
  const speedBizInHours: number[] = [];
  let withLeadNote = 0;
  let withContactNote = 0;
  let withinSla = 0;
  let afterHoursLeads = 0;
  let afterHoursNextMorning = 0;
  const bySource: Record<string, { added: number; hired: number; declined: number }> = {};
  const byChannel: Record<string, number> = {};
  const lossReasons: Record<string, number> = {};
  const uncontacted: Array<{ id: number; client: string | null; received_at: string; business_minutes_waiting: number }> = [];

  const parsed = new Map<number, ParsedIntakeNotes>();
  for (const m of matters) {
    if (!notesRead.has(m.id)) continue;
    const p = parseIntakeNotes(notesByMatter.get(m.id) ?? []);
    parsed.set(m.id, p);
    if (p.received_at) withLeadNote++;
    if (p.contacted_at) withContactNote++;
    const src = p.source ?? "(not logged)";
    bySource[src] ??= { added: 0, hired: 0, declined: 0 };
    bySource[src].added++;
    if (m.status_category === "hired") bySource[src].hired++;
    if (m.status_category === "declined") bySource[src].declined++;
    if (p.channel) byChannel[p.channel] = (byChannel[p.channel] ?? 0) + 1;
    if (p.reason && (m.status_category === "declined" || p.outcome)) {
      const key = `${p.outcome ?? m.status ?? "declined"}: ${p.reason}`;
      lossReasons[key] = (lossReasons[key] ?? 0) + 1;
    }
    if (p.received_at && p.contacted_at) {
      const biz = businessMinutesBetween(p.received_at, p.contacted_at);
      speedBiz.push(biz);
      if (biz <= opts.slaBusinessMinutes) withinSla++;
      if (isBusinessHours(p.received_at)) speedBizInHours.push(biz);
      else {
        afterHoursLeads++;
        // After-hours lead: met if contacted by 9:00 next business morning,
        // i.e. within the first 60 business minutes.
        if (biz <= 60) afterHoursNextMorning++;
      }
    } else if (p.received_at && !p.contacted_at && m.status_category === "intake") {
      uncontacted.push({
        id: m.id,
        client: m.client?.full_name ?? null,
        received_at: p.received_at,
        business_minutes_waiting: businessMinutesBetween(p.received_at, opts.asOf),
      });
    }
  }
  const notesN = notesRead.size;

  // ---- funnel stage timing (Grow's own timestamps) -----------------------
  const toLetterHrs: number[] = [];
  const letterToHireDays: number[] = [];
  const toHireDays: number[] = [];
  const leadToConsultBookedBiz: number[] = [];
  const leadToFeeAgreementBiz: number[] = [];
  const feeSentAt = (m: GrowMatterRow) => m.first_letter_sent_date ?? parsed.get(m.id)?.fee_agreement_sent_at ?? null;
  for (const m of matters) {
    const c = Date.parse(m.created_at);
    const p = parsed.get(m.id);
    const consultBooked = m.first_appointment_created_at ?? p?.consult_booked_at ?? null;
    if (p?.received_at && consultBooked) leadToConsultBookedBiz.push(businessMinutesBetween(p.received_at, consultBooked));
    const sent = feeSentAt(m);
    if (p?.received_at && sent) leadToFeeAgreementBiz.push(businessMinutesBetween(p.received_at, sent));
    if (sent) {
      const l = Date.parse(sent);
      if (l >= c) toLetterHrs.push((l - c) / 3600000);
      if (m.hired_date) {
        const h = Date.parse(`${m.hired_date}T12:00:00Z`);
        const days = Math.round((h - Date.parse(`${chicagoDate(sent)}T12:00:00Z`)) / DAY);
        if (days >= 0) letterToHireDays.push(days);
      }
    }
    if (m.hired_date) {
      const days = Math.round(
        (Date.parse(`${m.hired_date}T12:00:00Z`) - Date.parse(`${chicagoDate(m.created_at)}T12:00:00Z`)) / DAY
      );
      if (days >= 0) toHireDays.push(days);
    }
  }

  // ---- cohort conversion ----------------------------------------------
  type Cohort = {
    added: number;
    consult_booked: number;
    fee_agreement_sent: number;
    hired: number;
    declined: number;
    open: number;
  };
  const cohorts: Record<string, Cohort> = {};
  for (const m of matters) {
    const k = chicagoDate(m.created_at).slice(0, 7);
    const c = (cohorts[k] ??= { added: 0, consult_booked: 0, fee_agreement_sent: 0, hired: 0, declined: 0, open: 0 });
    c.added++;
    if (m.first_appointment_created_at || parsed.get(m.id)?.consult_booked_at) c.consult_booked++;
    if (feeSentAt(m)) c.fee_agreement_sent++;
    if (m.status_category === "hired") c.hired++;
    else if (m.status_category === "declined") c.declined++;
    else c.open++;
  }
  const cohortRows = Object.keys(cohorts)
    .sort()
    .map((k) => {
      const c = cohorts[k];
      const [y, mo] = k.split("-").map(Number);
      const monthEnd = Date.UTC(y, mo, 1); // first instant of the next month
      const matured = asOfMs - monthEnd >= opts.maturityDays * DAY;
      return {
        cohort: k,
        ...c,
        matured,
        consult_booked_rate_pct: pct(c.consult_booked, c.added),
        fee_agreement_rate_pct: pct(c.fee_agreement_sent, c.added),
        hire_rate_pct: matured ? pct(c.hired, c.added) : null,
        hire_rate_of_decided_pct: matured ? pct(c.hired, c.hired + c.declined) : null,
        hire_rate_to_date_pct: pct(c.hired, c.added),
      };
    });
  const maturedRows = cohortRows.filter((r) => r.matured);
  const mAdded = maturedRows.reduce((s, r) => s + r.added, 0);
  const mHired = maturedRows.reduce((s, r) => s + r.hired, 0);
  const mDecl = maturedRows.reduce((s, r) => s + r.declined, 0);
  const mOpen = maturedRows.reduce((s, r) => s + r.open, 0);

  // ---- breakdowns -----------------------------------------------------
  const breakdown = (keyOf: (m: GrowMatterRow) => string[]) => {
    const t: Record<string, { added: number; hired: number; declined: number; open: number }> = {};
    for (const m of matters) {
      for (const k of keyOf(m)) {
        const r = (t[k] ??= { added: 0, hired: 0, declined: 0, open: 0 });
        r.added++;
        if (m.status_category === "hired") r.hired++;
        else if (m.status_category === "declined") r.declined++;
        else r.open++;
      }
    }
    return Object.entries(t)
      .sort((a, b) => b[1].added - a[1].added)
      .map(([k, r]) => ({ key: k, ...r, hire_rate_of_decided_pct: pct(r.hired, r.hired + r.declined) }));
  };

  // ---- hygiene --------------------------------------------------------
  const open = matters.filter((m) => m.status_category !== "hired" && m.status_category !== "declined");
  const ageDays = (m: GrowMatterRow) => Math.floor((asOfMs - Date.parse(m.updated_at)) / DAY);
  const stale = open
    .filter((m) => ageDays(m) > opts.staleDays)
    .sort((a, b) => ageDays(b) - ageDays(a));
  const buckets = { "0-14": 0, "15-30": 0, "31-90": 0, "90+": 0 };
  for (const m of open) {
    const a = ageDays(m);
    if (a <= 14) buckets["0-14"]++;
    else if (a <= 30) buckets["15-30"]++;
    else if (a <= 90) buckets["31-90"]++;
    else buckets["90+"]++;
  }
  const byStatusOpen: Record<string, number> = {};
  for (const m of open) byStatusOpen[m.status ?? "unknown"] = (byStatusOpen[m.status ?? "unknown"] ?? 0) + 1;

  const coverage = {
    matters: matters.length,
    notes_read_for: notesN,
    lead_received_logged: { n: withLeadNote, of: notesN, pct: pct(withLeadNote, notesN) },
    first_contact_logged: { n: withContactNote, of: notesN, pct: pct(withContactNote, notesN) },
    consult_booked_in_grow: {
      n: matters.filter((m) => m.first_appointment_created_at).length,
      of: matters.length,
    },
    consult_booked_logged: {
      n: matters.filter((m) => m.first_appointment_created_at || parsed.get(m.id)?.consult_booked_at).length,
      of: matters.length,
    },
    projected_value_set: {
      n: matters.filter((m) => typeof m.projected_value === "number").length,
      of: matters.length,
    },
  };

  const warnings: string[] = [];
  if (notesN && withContactNote / notesN < 0.8)
    warnings.push(
      `Speed to lead covers only ${withContactNote} of ${notesN} matters (first contact not logged on the rest). Treat the speed numbers as a sample, not the firm's performance.`
    );
  if (!notesN) warnings.push("Notes were not read: speed to lead, source and loss reasons are not computed.");
  if (coverage.consult_booked_logged.n / Math.max(1, matters.length) < 0.5)
    warnings.push(
      "Consult booking is recorded on fewer than half the matters (neither Grow's first_appointment_created_at nor a [Consult Booked] note), so the consult stage of the funnel is under-measured."
    );
  if (stale.length)
    warnings.push(
      `${stale.length} open potentials untouched > ${opts.staleDays} days. Until they are dispositioned, open-pipeline counts and to-date conversion are overstated/understated respectively.`
    );

  return {
    as_of: opts.asOf,
    definitions: {
      speed_to_lead:
        "Business minutes (Mon–Fri 08:00–17:00 Central, no holidays) from [Lead Received] received_at to [First Contact] contacted_at.",
      sla_business_minutes: opts.slaBusinessMinutes,
      matured_cohort: `A creation month whose last day is at least ${opts.maturityDays} days before as_of. Conversion is reported only for matured cohorts; younger months show hire_rate_to_date only.`,
      fee_agreement_sent: "Grow first_letter_sent_date (first letter sent from Grow), else a [Fee Agreement Sent] note.",
      stale: `Open (not hired/declined) and not updated in more than ${opts.staleDays} days.`,
    },
    warnings,
    coverage,
    speed_to_lead: {
      all_business_minutes: dist(speedBiz),
      business_hours_leads_minutes: dist(speedBizInHours),
      within_sla: { n: withinSla, of: speedBiz.length, pct: pct(withinSla, speedBiz.length) },
      after_hours_leads: {
        n: afterHoursLeads,
        reached_by_9am_next_business_day: afterHoursNextMorning,
        pct: pct(afterHoursNextMorning, afterHoursLeads),
      },
      by_channel: byChannel,
      awaiting_first_contact: uncontacted.sort((a, b) => b.business_minutes_waiting - a.business_minutes_waiting),
    },
    stage_timing: {
      lead_to_consult_booked_business_minutes: dist(leadToConsultBookedBiz),
      lead_to_fee_agreement_sent_business_minutes: dist(leadToFeeAgreementBiz),
      grow_created_to_fee_agreement_sent_hours: dist(toLetterHrs),
      fee_agreement_sent_to_hired_days: dist(letterToHireDays),
      grow_created_to_hired_days: dist(toHireDays),
    },
    conversion: {
      matured_cohorts: {
        months: maturedRows.map((r) => r.cohort),
        added: mAdded,
        hired: mHired,
        declined: mDecl,
        still_open: mOpen,
        hire_rate_pct: pct(mHired, mAdded),
        hire_rate_of_decided_pct: pct(mHired, mHired + mDecl),
      },
      cohorts: cohortRows,
      by_matter_type: breakdown((m) => [m.type ?? "unknown"]),
      by_assignee: breakdown((m) => (m.matter_assignee_ids?.length ? m.matter_assignee_ids.map(name) : ["unassigned"])),
      by_source: Object.entries(bySource)
        .sort((a, b) => b[1].added - a[1].added)
        .map(([k, r]) => ({ key: k, ...r, hire_rate_of_decided_pct: pct(r.hired, r.hired + r.declined) })),
      loss_reasons: lossReasons,
    },
    hygiene: {
      open: open.length,
      open_by_status: byStatusOpen,
      open_by_days_since_update: buckets,
      stale_count: stale.length,
      stale: stale.slice(0, opts.staleListLimit ?? 50).map((m) => ({
        id: m.id,
        client: m.client?.full_name ?? null,
        description: m.description ?? null,
        status: m.status ?? null,
        type: m.type ?? null,
        assignees: (m.matter_assignee_ids ?? []).map(name),
        days_since_update: ageDays(m),
        created: chicagoDate(m.created_at),
      })),
      stale_truncated: stale.length > (opts.staleListLimit ?? 50),
    },
  };
}

/** Run fn over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

export function registerIntakeScorecardTools(server: McpServer): void {
  server.tool(
    "get_intake_scorecard",
    "Intake KPIs from Clio Grow for a creation window: speed to lead (business minutes from the [Lead Received] note to the [First Contact] note, % within SLA, after-hours leads reached by 9am), funnel stage timing (Grow created → fee agreement sent → hired), cohort conversion reported only for matured months, breakdowns by matter type, assignee and lead source, loss reasons from [Disposition] notes, and pipeline hygiene (open potentials by days since update, the stale list). Every metric carries its coverage; missing inputs are reported as warnings, never as zeros. Reads one notes call per matter in the window (cap with max_notes_matters).",
    {
      created_since: z
        .string()
        .describe("Cohort window start, ISO-8601 (e.g. 2026-08-01T00:00:00-05:00). Matters created on/after this are scored."),
      as_of: z.string().optional().describe("Evaluation instant, ISO-8601. Default now."),
      assignee_grow_user_id: z
        .number()
        .optional()
        .describe("Only matters assigned to this Grow user (an attorney or the intake specialist)."),
      maturity_days: z.number().optional().describe("Days after a month ends before its conversion is reported. Default 60."),
      stale_days: z.number().optional().describe("Open and not updated in more than this many days = stale. Default 14."),
      sla_business_minutes: z.number().optional().describe("Speed-to-lead SLA in business minutes. Default 15."),
      include_notes: z
        .boolean()
        .optional()
        .describe("Read each matter's notes for the structured intake notes (default true). False = Grow timestamps only."),
      max_notes_matters: z
        .number()
        .optional()
        .describe("Read notes for at most this many matters, newest first (default 250)."),
      stale_list_limit: z.number().optional().describe("Rows in the stale list (default 50)."),
    },
    async (args) => {
      try {
        const asOf = args.as_of ? new Date(args.as_of).toISOString() : new Date().toISOString();
        let matters = await growFetchAllPages<GrowMatterRow>("/matters", { created_since: args.created_since });
        if (args.assignee_grow_user_id != null)
          matters = matters.filter((m) => (m.matter_assignee_ids ?? []).includes(args.assignee_grow_user_id!));

        const users = await growFetchAllPages<any>("/users", {});
        const userNames: Record<number, string> = {};
        for (const u of users) userNames[u.id] = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();

        const notesByMatter = new Map<number, GrowNote[]>();
        const notesRead = new Set<number>();
        const noteErrors: number[] = [];
        let notesTruncated = false;
        if (args.include_notes !== false) {
          const cap = args.max_notes_matters ?? 250;
          const targets = [...matters].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          notesTruncated = targets.length > cap;
          await mapLimit(targets.slice(0, cap), 5, async (m) => {
            try {
              notesByMatter.set(m.id, await growFetchAllPages<GrowNote>(`/matters/${m.id}/notes`, {}, 200));
              notesRead.add(m.id);
            } catch {
              noteErrors.push(m.id);
            }
          });
        }

        const card = computeIntakeScorecard(matters, notesByMatter, {
          asOf,
          maturityDays: args.maturity_days ?? 60,
          staleDays: args.stale_days ?? 14,
          slaBusinessMinutes: args.sla_business_minutes ?? 15,
          userNames,
          notesRead,
          staleListLimit: args.stale_list_limit,
        });
        if (notesTruncated)
          card.warnings.push(
            `Notes read for the newest ${args.max_notes_matters ?? 250} matters only; speed and source metrics exclude older ones.`
          );
        if (noteErrors.length)
          card.warnings.push(`Notes could not be read for ${noteErrors.length} matters (ids: ${noteErrors.slice(0, 10).join(", ")}).`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { window: { created_since: args.created_since, assignee_grow_user_id: args.assignee_grow_user_id ?? null }, ...card },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        const status = err.response?.status;
        return {
          content: [
            {
              type: "text" as const,
              text: `Error building intake scorecard${status ? ` (HTTP ${status})` : ""}: ${err.message}. If Grow returns 401/403, run grow_who_am_i.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

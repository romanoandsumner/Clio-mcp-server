// ============================================================
// Excluded-hours builder. The 26 Compare "Billable Hours" (col I) and the paralegal
// hour bonus count all billable hours WORKED — including real worked time on
// contingency/flat-fee matters. The ONLY thing that must be backed out is Rachel's
// synthetic fee placeholder: to get a contingency/flat fee onto an invoice she
// hand-creates a SINGLE one-hour time entry whose dollar value is the whole fee, so
// its per-hour rate does NOT match the timekeeper's standard hourly rate. Those
// placeholder hours aren't real worked time, so we subtract them from col I (their
// DOLLARS still count in billed $ / collections).
//
// TWO-STEP, MATTER-AUGMENTED DETECTION (the corrected rule):
//   Step 1 — CANDIDATES: a SINGLE one-hour billable entry whose rate doesn't correspond
//     to the timekeeper's standard hourly rate. (A timekeeper's standard rate is the
//     modal rate among their own non-1h billable entries; when none exist to compare
//     against, a 1.0h entry priced above FALLBACK_MAX_HOURLY_RATE is treated as a dump.)
//   Step 2 — MATTER GATE: a candidate is stripped ONLY if its matter is actually a
//     fee-based matter — contingency, a flat-fee practice area (Estate Planning /
//     Corporate), or flagged with the "Flat Fee" custom field. Otherwise it PASSES
//     THROUGH. This is what protects legitimate capped-rate hourly work: e.g. NRN's
//     court-appointed Appointment / Guardianship matters are billed at a $400/hr cap
//     (≠ his standard rate) but are real hourly time on hourly matters, so they are NOT
//     stripped. Rate mismatch alone is not enough — the matter must be fee-based.
//
// Matter details are fetched ONLY for the matters that own a candidate entry (not the
// whole matter list), and a per-matter lookup failure FAILS SAFE toward inclusion (the
// entry is NOT stripped). Contingency / Flat Fee come from yes/no custom fields (Clio's
// billing_method is unreliable — it labels real contingency matters "hourly"); the
// flat-fee practice areas come from practice_area{name}.
// ============================================================
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import type { RosterMember } from "../domain/roster";
import { placeholderKey } from "../clio/reportCsv";

// month (1-12) -> user_id -> placeholder (fee-dump) hours to back out of worked billable
export type ExcludedHoursByMonth = Record<number, Record<number, number>>;

/**
 * Flat-fee practice areas (exact practice_area{name} strings as they appear in Clio,
 * confirmed against the firm's matters). Work on these is billed as a fixed fee, so a
 * 1.0h off-rate entry on one is a fee placeholder. Gated/hourly areas (Appointment,
 * Guardianship, Probate, Estate Litigation, …) are deliberately NOT here — that work is
 * hourly even when billed at a court-capped rate.
 */
export const FLAT_FEE_PRACTICE_AREAS = new Set<string>(["Estate Planning", "Corporate"]);

/**
 * A matter's billing_method counts as excluded when it is contingency or flat-fee.
 * RETAINED as a pure helper (and unit-tested), but NO LONGER used to decide stripping —
 * billing_method mislabels real contingency matters "hourly" and can't distinguish
 * capped-rate hourly work from flat-fee work. The matter gate now uses the Contingency /
 * Flat Fee custom fields + practice area instead (see matterQualifiesForStrip).
 */
export function isExcludedBillingMethod(method: string | undefined | null): boolean {
  const m = String(method || "").toLowerCase();
  return m.includes("conting") || m.includes("flat") || m === "fixed";
}

/**
 * True when a matter's yes/no custom field `fieldNameLower` (compared case-insensitively)
 * is set to a truthy value. We read custom_field_values as { field_name, value } (and
 * also accept a nested custom_field:{ name } shape for safety) and treat
 * true/"true"/"yes"/"y"/"1"/"checked" as yes. A matter that simply doesn't carry the
 * field (e.g. "Flat Fee", which doesn't exist in Clio yet) returns false — no error.
 */
function hasYesCustomField(matter: any, fieldNameLower: string): boolean {
  const cfvs = matter?.custom_field_values;
  if (!Array.isArray(cfvs)) return false;
  for (const cf of cfvs) {
    const name = String(cf?.custom_field?.name ?? cf?.field_name ?? cf?.name ?? "").toLowerCase().trim();
    if (name !== fieldNameLower) continue;
    const v = cf?.value;
    if (v === true) return true;
    const s = String(v ?? "").toLowerCase().trim();
    return s === "true" || s === "yes" || s === "y" || s === "1" || s === "checked";
  }
  return false;
}

/**
 * True when a matter's "Contingency" yes/no custom field is set. The firm's source of
 * truth for contingency status — NOT billing_method, which mislabels these matters
 * "hourly".
 */
export function isContingencyMatter(matter: any): boolean {
  return hasYesCustomField(matter, "contingency");
}

/**
 * True when a matter's "Flat Fee" yes/no custom field is set. This field does NOT exist
 * in Clio yet (it's being added); until then no matter carries it and this returns false
 * for everyone, gracefully. Built in now so the gate picks it up automatically once the
 * field is created — matching the existing Contingency comparison pattern exactly.
 */
export function isFlatFeeMatter(matter: any): boolean {
  return hasYesCustomField(matter, "flat fee");
}

/** True when a matter's practice_area{name} is a flat-fee practice area. */
export function isFlatFeePracticeArea(matter: any): boolean {
  return FLAT_FEE_PRACTICE_AREAS.has(String(matter?.practice_area?.name ?? "").trim());
}

/**
 * The matter gate: a 1.0h off-rate candidate is a fee placeholder (strip it) ONLY when
 * its matter is fee-based — contingency, a flat-fee practice area, or "Flat Fee"-flagged.
 * Legitimate capped-rate hourly work (e.g. court-appointed Appointment/Guardianship at
 * $400/hr) fails all three and PASSES THROUGH.
 */
export function matterQualifiesForStrip(matter: any): boolean {
  return isContingencyMatter(matter) || isFlatFeePracticeArea(matter) || isFlatFeeMatter(matter);
}

// A 1.0h entry whose rate exceeds this is treated as a fee placeholder even when the
// timekeeper's standard rate can't be inferred (no other billable entries to compare).
// Set well above any real hourly rate at the firm; a contingency/flat fee dumped onto a
// single hour sits far above it.
const FALLBACK_MAX_HOURLY_RATE = 1500;
const ONE_HOUR_TOLERANCE = 0.05;  // hours — "single hour" entry
const RATE_MATCH_TOLERANCE = 1;   // dollars — "corresponds to the hourly rate"

const isOneHour = (h: number) => Math.abs(h - 1) < ONE_HOUR_TOLERANCE;

// One billable time entry reduced to the fields the fee-placeholder test needs.
// `rate` is the per-hour price; `hours` the duration.
export type ContingencyEntry = { uid: number; month: number; hours: number; rate: number };
// A candidate entry also carries the matter, so the matter gate can be applied per entry.
export type PlaceholderCandidate = ContingencyEntry & { matterId: number };

/** Per-user standard rate = modal rate among non-1h, positive-rate entries (a 1.0h dump
 *  can't define the standard). */
export function standardRateByUser(entries: ContingencyEntry[]): Record<number, number> {
  const rateCounts: Record<number, Map<number, number>> = {};
  for (const e of entries) {
    if (isOneHour(e.hours) || e.rate <= 0) continue;
    const m = (rateCounts[e.uid] ??= new Map<number, number>());
    const bucket = Math.round(e.rate);
    m.set(bucket, (m.get(bucket) ?? 0) + 1);
  }
  const standardRate: Record<number, number> = {};
  for (const uid of Object.keys(rateCounts).map(Number)) {
    let best = 0, bestCount = -1;
    for (const [rate, count] of rateCounts[uid]) if (count > bestCount) { bestCount = count; best = rate; }
    standardRate[uid] = best;
  }
  return standardRate;
}

/**
 * Step 1 (rate test only): is this a 1.0h entry whose rate doesn't correspond to the
 * timekeeper's standard hourly rate? Candidates still have to pass the matter gate
 * before they're actually stripped.
 */
export function isFeePlaceholderRate(hours: number, rate: number, std: number | undefined): boolean {
  if (!isOneHour(hours)) return false;
  return std ? Math.abs(rate - std) > RATE_MATCH_TOLERANCE : rate > FALLBACK_MAX_HOURLY_RATE;
}

/**
 * PURE rate-only detection of fee placeholders (no matter awareness). Sums the 1.0h
 * off-rate entries by month×user. RETAINED for unit tests and as the rate-test building
 * block; the production path (buildExcludedHoursByMonth) layers the matter gate on top
 * so capped-rate hourly work isn't caught.
 */
export function classifyFeePlaceholders(entries: ContingencyEntry[]): ExcludedHoursByMonth {
  const std = standardRateByUser(entries);
  const out: ExcludedHoursByMonth = {};
  for (const e of entries) {
    if (!isFeePlaceholderRate(e.hours, e.rate, std[e.uid])) continue;
    const slot = (out[e.month] ??= {});
    slot[e.uid] = (slot[e.uid] ?? 0) + e.hours;
  }
  return out;
}

/**
 * Fee-placeholder hours by month×user, for months 1..`month`. Pull each roster member's
 * billable TimeEntries, identify 1.0h off-rate CANDIDATES, then fetch matter details ONLY
 * for the matters that own a candidate and strip a candidate only if its matter is
 * fee-based (contingency / flat-fee practice area / "Flat Fee" custom field). A per-matter
 * lookup failure fails safe toward inclusion (NOT stripped).
 */
export async function buildExcludedHoursByMonth(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[] } = {},
): Promise<ExcludedHoursByMonth> {
  const out: ExcludedHoursByMonth = {};
  for (const p of await findFeePlaceholders(year, month, roster, opts)) {
    const slot = (out[p.month] ??= {});
    slot[p.uid] = (slot[p.uid] ?? 0) + p.hours;
  }
  return out;
}

/** One stripped fee placeholder, carrying enough identity to find the same entry on
 *  a Realization-report row (which has no entry id) — see placeholderKey in
 *  clio/reportCsv. */
export type FeePlaceholder = PlaceholderCandidate & { date: string; matterNumber: string };

/**
 * The individual fee-placeholder entries behind buildExcludedHoursByMonth — same pull,
 * same rate test, same matter gate, same fail-safe. Exposed so the Realization tab can
 * back out exactly the entries 26 Compare col I backs out.
 */
export async function findFeePlaceholders(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[] } = {},
): Promise<FeePlaceholder[]> {
  const months = new Set(opts.months ?? Array.from({ length: month }, (_, i) => i + 1));
  const maxMonth = Math.max(...months);
  const monthEnd = `${year}-${String(maxMonth).padStart(2, "0")}-${String(new Date(year, maxMonth, 0).getDate()).padStart(2, "0")}`;
  const hoursOf = (a: any) => (a.rounded_quantity ?? a.quantity ?? 0) / 3600;
  const rateOf = (a: any) => Number(a.price) || 0;

  // Step 0 — pull each roster member's billable time entries in the window (one pull per
  // member, scoped by user_id), carrying rate + matter so candidates can be matter-gated.
  const entries: Array<PlaceholderCandidate & { date: string }> = [];
  for (const r of roster) {
    let acts: any[] = [];
    try {
      acts = await fetchAllPages<any>("/activities", {
        type: "TimeEntry",
        fields: "id,date,quantity,rounded_quantity,price,non_billable,matter{id},user{id}",
        user_id: r.user_id,
        created_since: `${year}-01-01T00:00:00+00:00`,
      });
    } catch (e: any) {
      console.warn(`[Dashboard] fee-placeholder activity pull failed for ${r.initials}: ${e?.message ?? e}`);
      continue;
    }
    for (const a of acts) {
      if (a.non_billable === true) continue; // only entries that are in col I to begin with
      if (a.date < `${year}-01-01` || a.date > monthEnd) continue;
      const m = parseInt(String(a.date).slice(5, 7), 10);
      if (!m || !months.has(m)) continue;
      const uid = a.user?.id;
      const matterId = a.matter?.id;
      if (!uid || !matterId) continue;
      entries.push({ uid, month: m, hours: hoursOf(a), rate: rateOf(a), matterId, date: String(a.date) });
    }
  }

  // Step 1 — candidates: 1.0h entries whose rate doesn't match the timekeeper's standard
  // (standard inferred from ALL their billable work, so it's the real modal hourly rate).
  const std = standardRateByUser(entries);
  const candidates = entries.filter((e) => isFeePlaceholderRate(e.hours, e.rate, std[e.uid]));

  // Step 2 — fetch matter details ONLY for the matters that own a candidate (deduped).
  // Per-matter failure (timeout/404/…) fails safe: the matter stays absent below, so its
  // candidates are NOT stripped.
  const candidateMatterIds = [...new Set(candidates.map((c) => c.matterId))];
  const matterById = new Map<number, any>();
  for (const mid of candidateMatterIds) {
    try {
      const res = await rawGetSingle(`/matters/${mid}`, {
        fields: "id,display_number,practice_area{name},custom_field_values{field_name,value}",
      });
      matterById.set(mid, res?.data ?? res);
    } catch (e: any) {
      console.warn(`[Dashboard] candidate matter ${mid} lookup failed (${e?.response?.status ?? e?.message ?? e}); NOT stripping its 1h entries (fail safe to inclusion)`);
    }
  }

  // Step 3 — strip a candidate only if its matter is fee-based; otherwise pass through.
  const out: FeePlaceholder[] = [];
  let stripped = 0, passedThrough = 0;
  for (const c of candidates) {
    const matter = matterById.get(c.matterId);
    if (!matter || !matterQualifiesForStrip(matter)) { passedThrough++; continue; }
    out.push({ ...c, matterNumber: String(matter.display_number ?? "") });
    stripped++;
  }
  console.log(`[Dashboard] fee-placeholder candidates=${candidates.length}, candidate matters looked up=${candidateMatterIds.length}, stripped=${stripped}, passed through (legit hourly)=${passedThrough}`);
  return out;
}

/**
 * placeholderKey()s for every fee placeholder in `months` of `year`, for backing them
 * out of the Realization tab. Never throws: if the pull fails outright the tab is
 * written without placeholder stripping (the prior behavior) and the failure is
 * logged, rather than losing the whole tab.
 */
export async function feePlaceholderKeys(
  year: number,
  months: number[],
  roster: RosterMember[],
): Promise<Set<string>> {
  try {
    const found = await findFeePlaceholders(year, Math.max(...months), roster, { months });
    const keys = new Set<string>();
    for (const p of found) {
      if (!p.matterNumber) continue; // no display number to match a report row on
      keys.add(placeholderKey(p.uid, p.date, p.matterNumber, p.rate));
    }
    return keys;
  } catch (e: any) {
    console.warn(`[Dashboard] fee-placeholder keys for Realization failed (${e?.message ?? e}); placeholders NOT backed out of the Realization tab this run`);
    return new Set();
  }
}

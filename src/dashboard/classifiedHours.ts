// ============================================================
// Entry-level hours classifier — the SINGLE filtration shared by the monthly
// dashboard model and the on-tempo weekly goals sheets, so both report the same
// utilization numerator (billable ÷ 1880/12) and reconcile at month close.
//
// TWO BASES, computed in one pass (see `cls` vs `clsRaw` below):
//
// RAW basis (`clsRaw`) — Clio's native entry-level `non_billable` flag, and
// nothing else. This is the figure 26 Compare carried from #186 until the
// internal-time adjustment below, and it is what `billable_actual_raw` reports:
//   nonbillable — non_billable === true. Price is irrelevant: internal work
//                 booked at a dollar rate (e.g. a $525/hr RomSum admin entry)
//                 but flagged non-billable in Clio is nonbillable.
//   excluded    — one of Rachel's synthetic 1-hour fee-placeholder entries
//                 (off-standard-rate 1.0h BILLABLE-flagged entry on a fee-based
//                 matter, per the two-step rule in excludedHours.ts). Not real
//                 worked time: dropped from BOTH billable and nonbillable.
//   billable    — everything else (non_billable === false).
//
// ADJUSTED basis (`cls`) — the raw basis PLUS the firm-internal reclassification,
// active whenever `excludeInternal` is true (the DEFAULT). Rate and the matter's
// client ARE consulted here: a billable-flagged entry is moved to NONBILLABLE
// when either
//   (a) the matter's client is the firm itself (FIRM_SELF_CLIENT_ID) — the
//       structural signal. Catches 02888-Admin, 00050-Potential Clients, and any
//       future internal matter automatically, with no name/number list to
//       maintain; or
//   (b) the entry is billable-flagged but carries NO money — rate 0 AND amount 0
//       — the rate-based safety net for internal time booked under some other
//       client.
// Reclassified hours MOVE to nonbillable: they are still tracked time, so
// total (billable + nonbillable) is unchanged on both bases and the dashboard's
// "Untracked" column can't drift. The size of the move is reported separately
// (see `internalHours`) so the two bases always reconcile explicitly.
//
// WHY: #186 (2026-07-15) made the split flag-only, dropping BOTH guards that had
// been keeping $0 firm-internal time out of billable — the pre-2026-07-09
// `price > 0` heuristic and the 2026-07-09 admin-matter-prefix rule. That fixed
// the mirror-image leak (rated RomSum time flagged non-billable was landing in
// billable) but opened this one: 184.0 hrs of $0 "billable" time on 02888-Admin
// and 00050-Potential Clients inflated one timekeeper's YTD over/under from
// ~+345 to +529. Rule (a) restores the structural guard without reintroducing a
// matter-name heuristic.
//
// CAVEAT on rule (b): a genuinely $0-priced entry on a CLIENT matter — real
// worked time on a contingency or flat-fee matter that was never given a rate —
// also has rate 0 / amount 0, so rule (b) will move it to nonbillable too. This
// is the same under-count the pre-2026-07-09 `price > 0` heuristic had and that
// e163235 called out.
//
// CAVEAT on rule (a): client 866197764 is NOT exclusively internal. As of
// 2026-08-24 it owns 25 matters, and while that set is a superset of the four
// old admin prefixes (00706/00316, 00050, 00707, 02888) plus the #186
// RomSum-Marketing/Finance matters, it ALSO carries matters holding real rated
// client work — notably 02671-Anike Fort Bend Property Ownership (16.2 hrs /
// $6,077 of title, contract and eminent-domain work in 2026 at $195–$525) and
// 01537-Mediation Services (0.6 hrs at $450/$125). Rule (a) moves those to
// nonbillable too, which UNDER-counts billable. That is the specified behavior —
// rule (a) is deliberately client-based, not rate-based, so it still catches
// internal work booked at a rate — but the exposure is measured rather than
// hidden: `firmSelfClientRatedHours` counts the firm-self-client hours that
// carried money, which is exactly the suspicious population. If that number is
// material, the fix is a matter-level exception list for the handful of
// client-work matters filed under the firm, not loosening rule (a).
//
// All three counters (firmSelfClientHours, firmSelfClientRatedHours,
// zeroValueHours) are reported so both exposures stay visible.
// ============================================================
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import {
  standardRateByUser, isFeePlaceholderRate, matterQualifiesForStrip, isContingencyMatter,
} from "./excludedHours";

/**
 * Contact id of "Romano & Sumner, LLC" — the firm acting as its own client.
 * Every firm-internal matter (02888-Admin, 00050-Potential Clients, and any
 * future one) hangs off this client, which is why this single id replaces the
 * old display-number prefix list as the structural internal-time signal.
 */
export const FIRM_SELF_CLIENT_ID = 866197764;

export type EntryClass = "billable" | "nonbillable" | "excluded";

export type ClassifiedTimeEntry = {
  id: number;
  uid: number;
  userName: string;
  date: string;   // YYYY-MM-DD work date
  hours: number;  // rounded_quantity (billed-increment) hours
  /** ADJUSTED class — the reporting basis (firm-internal time reclassified). */
  cls: EntryClass;
  /** RAW class — flag-only, the `billable_actual_raw` basis. */
  clsRaw: EntryClass;
  /** True when the internal adjustment moved this entry out of billable. */
  internal: boolean;
  /** Which rule caught it: the firm-self client (a) or the $0 net (b). */
  internalReason?: "firm_self_client" | "zero_rate_and_amount";
  /** True when a reclassified entry carried money — see firmSelfClientRatedHours. */
  internalRated?: boolean;
  /**
   * True when the entry meets EITHER internal rule — firm-self client, or rate 0
   * AND amount 0 — REGARDLESS of its Clio non_billable flag. `internal` is the
   * subset the adjustment had to move (raw-billable); the rest were already
   * flagged non-billable by the timekeeper. Always false for fee placeholders.
   */
  internalAny: boolean;
  /**
   * True when the entry's matter has the "Contingency" custom field checked.
   * null when the contingency lookup was not run or failed — never a silent
   * false, so a broken lookup can't report 0 contingency hours.
   */
  contingency: boolean | null;
};

// Raw shape the pure classifier consumes (one row per /activities TimeEntry).
export type RawTimeEntry = {
  id: number;
  uid: number;
  userName: string;
  date: string;
  hours: number;
  /** `price` on the activity — the hourly rate. Feeds the fee-placeholder
   *  exclusion AND internal rule (b). */
  rate: number;
  /** `total` on the activity — the entry's dollar value. Feeds internal rule (b). */
  amount: number;
  matterId?: number;
  /** The matter's client contact id. Feeds internal rule (a). */
  clientId?: number;
  nonBillableFlag: boolean;
  /** Matter is contingency-flagged; null = unknown (lookup not run / failed). */
  contingency?: boolean | null;
};

/** Field list an /activities pull needs to feed this classifier. */
export const CLASSIFIER_ACTIVITY_FIELDS =
  "id,date,quantity,rounded_quantity,price,total,non_billable,matter{id},user{id,name}";

export type ClassifyOptions = {
  /** Apply the firm-internal reclassification. Defaults to TRUE. */
  excludeInternal?: boolean;
};

/**
 * THE raw billable-vs-nonbillable decision, in one place: an entry is
 * nonbillable exactly when Clio's entry-level non_billable flag is true. Strict
 * === true so a missing/omitted field never silently flips an entry to
 * nonbillable.
 */
export function isNonBillableEntry(nonBillableFlag: unknown): boolean {
  return nonBillableFlag === true;
}

/** Internal rule (a): the matter's client is the firm itself. */
export function isFirmSelfClient(clientId: number | undefined): boolean {
  return clientId === FIRM_SELF_CLIENT_ID;
}

/**
 * Internal rule (b): billable-flagged but carrying no money at all. Both the
 * rate and the amount must be exactly zero — an entry with a rate but a zeroed
 * total (a full write-down) is still client work and stays billable.
 */
export function isZeroValueBillable(e: Pick<RawTimeEntry, "rate" | "amount" | "nonBillableFlag">): boolean {
  return !isNonBillableEntry(e.nonBillableFlag) && e.rate === 0 && e.amount === 0;
}

/**
 * The internal-time decision: which rule (if any) moves this entry out of
 * billable. Returns undefined when the entry is not internal. Rule (a) is
 * reported in preference to rule (b) when both match, because (a) is the
 * structural signal and (b) is only its safety net.
 */
export function internalReasonFor(
  e: Pick<RawTimeEntry, "rate" | "amount" | "clientId" | "nonBillableFlag">,
): "firm_self_client" | "zero_rate_and_amount" | undefined {
  if (isFirmSelfClient(e.clientId)) return "firm_self_client";
  if (isZeroValueBillable(e)) return "zero_rate_and_amount";
  return undefined;
}

/**
 * Internal by EITHER rule, ignoring the non_billable flag — the population a
 * person measuring "all internal time" counts. Compare internalReasonFor, which
 * only fires on billable-flagged entries because only those need moving.
 */
export function matchesInternalRuleIgnoringFlag(
  e: Pick<RawTimeEntry, "rate" | "amount" | "clientId">,
): boolean {
  return isFirmSelfClient(e.clientId) || (e.rate === 0 && e.amount === 0);
}

/**
 * Pure classification, producing both bases in one pass.
 *
 * Precedence: the non_billable flag wins over everything (a flagged entry must
 * never leave the nonbillable sum), then the firm-internal rules, then the
 * placeholder set. Placeholders are by construction billable-flagged entries on
 * fee-based matters, so they can't be on a firm-internal matter — the
 * internal/placeholder overlap is theoretical, and nonbillable is the safer
 * bucket if it ever happens.
 */
export function classifyRawEntries(
  raw: RawTimeEntry[],
  excludedEntryIds: Set<number>,
  opts: ClassifyOptions = {},
): ClassifiedTimeEntry[] {
  const excludeInternal = opts.excludeInternal !== false;
  return raw.map((e) => {
    const clsRaw: EntryClass = isNonBillableEntry(e.nonBillableFlag) ? "nonbillable"
      : excludedEntryIds.has(e.id) ? "excluded"
      : "billable";
    // Only a raw-BILLABLE entry can be reclassified: flagged entries are already
    // nonbillable, and placeholders aren't real worked time in either basis.
    const reason = excludeInternal && clsRaw === "billable" ? internalReasonFor(e) : undefined;
    return {
      id: e.id, uid: e.uid, userName: e.userName, date: e.date, hours: e.hours,
      cls: reason ? "nonbillable" : clsRaw,
      clsRaw,
      internal: reason !== undefined,
      internalReason: reason,
      internalRated: reason !== undefined && (e.rate > 0 || e.amount > 0),
      internalAny: excludeInternal && clsRaw !== "excluded" && matchesInternalRuleIgnoringFlag(e),
      contingency: e.contingency ?? null,
    };
  });
}

/** Hours summed on both bases, so callers never re-derive the reconciliation. */
export type HoursTotals = {
  /** Adjusted billable — the reporting figure (`billable_actual`). */
  billable: number;
  /** Flag-only billable — ties to 26 Compare's pre-adjustment col I (`billable_actual_raw`). */
  billableRaw: number;
  /** Adjusted nonbillable (includes the reclassified internal hours). */
  nonbillable: number;
  /** Flag-only nonbillable. */
  nonbillableRaw: number;
  /** billableRaw − billable: the whole difference between the two bases. */
  internalHours: number;
  /** Internal hours caught by rule (a) — the firm as its own client. */
  firmSelfClientHours: number;
  /**
   * Subset of firmSelfClientHours that carried money (rate > 0 or amount > 0) —
   * i.e. rule (a) reclassified RATED work. Internal time is normally booked at
   * $0, so a material figure here means rule (a) is catching real client work
   * filed under the firm's own client (see the CAVEAT above), not internal time.
   */
  firmSelfClientRatedHours: number;
  /** Internal hours caught by rule (b) — $0 rate AND $0 amount. */
  zeroValueHours: number;
  /**
   * ALL hours meeting either internal rule, regardless of the Clio flag.
   * Always equals internalHours + internalSelfFlaggedHours (asserted by
   * assertTotalsReconcile).
   */
  internalTotalHours: number;
  /** Internal-rule hours the timekeeper already flagged non-billable in Clio. */
  internalSelfFlaggedHours: number;
  /** Worked hours (billable + nonbillable, adjusted basis) on contingency matters. */
  contingencyHours: number;
  /** Subset of contingencyHours that is billable on the adjusted basis. */
  contingencyBillableHours: number;
};

export function emptyTotals(): HoursTotals {
  return {
    billable: 0, billableRaw: 0, nonbillable: 0, nonbillableRaw: 0,
    internalHours: 0, firmSelfClientHours: 0, firmSelfClientRatedHours: 0,
    zeroValueHours: 0, internalTotalHours: 0, internalSelfFlaggedHours: 0,
    contingencyHours: 0, contingencyBillableHours: 0,
  };
}

/** Accumulate one classified entry into a totals bucket. */
export function addToTotals(t: HoursTotals, e: ClassifiedTimeEntry): void {
  if (e.cls === "billable") t.billable += e.hours;
  else if (e.cls === "nonbillable") t.nonbillable += e.hours;
  if (e.clsRaw === "billable") t.billableRaw += e.hours;
  else if (e.clsRaw === "nonbillable") t.nonbillableRaw += e.hours;
  if (e.internal) {
    t.internalHours += e.hours;
    if (e.internalReason === "firm_self_client") {
      t.firmSelfClientHours += e.hours;
      if (e.internalRated) t.firmSelfClientRatedHours += e.hours;
    } else t.zeroValueHours += e.hours;
  }
  // Counted independently of `internal` (from the flag-agnostic rule + clsRaw),
  // so the reconciliation below is a real cross-check, not a tautology.
  if (e.internalAny) {
    t.internalTotalHours += e.hours;
    if (e.clsRaw === "nonbillable") t.internalSelfFlaggedHours += e.hours;
  }
  if (e.contingency === true && e.cls !== "excluded") {
    t.contingencyHours += e.hours;
    if (e.cls === "billable") t.contingencyBillableHours += e.hours;
  }
}

/**
 * Fail loudly if the bases stop reconciling. Two identities must hold:
 *   billableRaw − billable            == internalHours
 *   internalTotalHours                == internalHours + internalSelfFlaggedHours
 * A drift here means a classification bug, and the numbers must not ship.
 */
export function assertTotalsReconcile(t: HoursTotals, label: string, tol = 0.05): void {
  const d1 = (t.billableRaw - t.billable) - t.internalHours;
  const d2 = t.internalTotalHours - (t.internalHours + t.internalSelfFlaggedHours);
  if (Math.abs(d1) > tol || Math.abs(d2) > tol) {
    throw new Error(
      `[Goals] hours do not reconcile for ${label}: raw−net−reclassified=${d1.toFixed(2)}, ` +
      `internalTotal−(reclassified+selfFlagged)=${d2.toFixed(2)}`,
    );
  }
}

/** Sum a set of classified entries on both bases. */
export function sumTotals(entries: ClassifiedTimeEntry[]): HoursTotals {
  const t = emptyTotals();
  for (const e of entries) addToTotals(t, e);
  return t;
}

/**
 * Identify fee-placeholder ENTRY IDs among the raw entries — the entry-level
 * twin of buildExcludedHoursByMonth (same population: entries whose
 * non_billable flag isn't set; same rate test against the timekeeper's modal
 * standard rate; same matter gate; same fail-safe toward inclusion when a
 * matter lookup fails).
 */
export async function findPlaceholderEntryIds(raw: RawTimeEntry[]): Promise<Set<number>> {
  const pop = raw.filter((e) => !isNonBillableEntry(e.nonBillableFlag) && e.matterId !== undefined);
  const rateEntries = pop.map((e) => ({
    uid: e.uid, month: parseInt(e.date.slice(5, 7), 10) || 0, hours: e.hours, rate: e.rate,
  }));
  const std = standardRateByUser(rateEntries);
  const candidates = pop.filter((e) => isFeePlaceholderRate(e.hours, e.rate, std[e.uid]));
  const excluded = new Set<number>();
  const candidateMatterIds = [...new Set(candidates.map((c) => c.matterId as number))];
  for (const mid of candidateMatterIds) {
    try {
      const res = await rawGetSingle(`/matters/${mid}`, {
        fields: "id,practice_area{name},custom_field_values{field_name,value}",
      });
      const matter = (res as any)?.data ?? res;
      if (!matterQualifiesForStrip(matter)) continue;
      for (const c of candidates) if (c.matterId === mid) excluded.add(c.id);
    } catch (e: any) {
      console.warn(`[Goals] candidate matter ${mid} lookup failed (${e?.response?.status ?? e?.message ?? e}); NOT stripping its 1h entries (fail safe to inclusion)`);
    }
  }
  return excluded;
}

/**
 * matterId → client contact id for the FIRM'S OWN matters, from one /matters
 * pull scoped by `client_id` (25 rows as of 2026-08-24, versus a full matter
 * list). Only firm-self matters are mapped because that is the only value rule
 * (a) needs — every other matter resolves to undefined, which rule (a) ignores.
 *
 * Each returned row's client id is RE-VERIFIED against FIRM_SELF_CLIENT_ID, so
 * if Clio ever stops honouring the `client_id` filter the result is a larger
 * pull, never a wrong answer (an unfiltered response would otherwise mark every
 * matter internal).
 *
 * A failed pull FAILS SAFE toward the raw basis: an empty map means rule (a)
 * catches nothing and only the $0 safety net (b) applies, so time is never
 * silently dropped from billable because a lookup broke.
 */
export async function buildMatterClientMap(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    // No `status` filter: closed internal matters can still own worked time in
    // the period being classified.
    const matters = await fetchAllPages<any>("/matters", {
      client_id: FIRM_SELF_CLIENT_ID,
      fields: "id,client{id}",
    });
    let foreign = 0;
    for (const m of matters) {
      const cid = m?.client?.id;
      if (typeof m?.id !== "number") continue;
      if (cid === FIRM_SELF_CLIENT_ID) map.set(m.id, cid);
      else foreign++;
    }
    if (foreign > 0) {
      console.warn(`[Goals] /matters client_id filter returned ${foreign} matter(s) owned by another client; ignored (rule (a) only trusts a verified client id)`);
    }
  } catch (e: any) {
    console.warn(`[Goals] firm-self matter pull failed (${e?.message ?? e}); firm-self-client rule (a) DISABLED for this run, $0 rule (b) still applies`);
  }
  return map;
}

/**
 * Ids of every matter (any status) whose "Contingency" custom field is checked —
 * the firm's source of truth for contingency (billing_method mislabels these
 * "hourly"). One paginated /matters pull with custom_field_values expanded;
 * Clio has no server-side custom-field filter.
 *
 * Returns null on failure so callers report contingency as UNAVAILABLE rather
 * than as 0 hours.
 */
export async function buildContingencyMatterSet(): Promise<Set<number> | null> {
  try {
    const matters = await fetchAllPages<any>("/matters", {
      fields: "id,custom_field_values{id,field_name,value}",
    });
    const set = new Set<number>();
    for (const m of matters) if (typeof m?.id === "number" && isContingencyMatter(m)) set.add(m.id);
    return set;
  } catch (e: any) {
    console.warn(`[Goals] contingency matter pull failed (${e?.message ?? e}); contingency hours reported as unavailable`);
    return null;
  }
}

/** Map one Clio /activities TimeEntry row onto the classifier's input shape. */
export function toRawTimeEntry(
  a: any,
  fallbackUid: number,
  clientByMatter?: Map<number, number>,
  contingencyMatters?: Set<number> | null,
): RawTimeEntry {
  const matterId = a.matter?.id;
  return {
    id: a.id,
    uid: a.user?.id ?? fallbackUid,
    userName: a.user?.name ?? "Unknown",
    date: a.date,
    hours: (a.rounded_quantity ?? a.quantity ?? 0) / 3600,
    rate: Number(a.price) || 0,
    amount: Number(a.total) || 0,
    matterId,
    clientId: matterId !== undefined ? clientByMatter?.get(matterId) : undefined,
    nonBillableFlag: a.non_billable === true,
    contingency: contingencyMatters
      ? (matterId !== undefined && contingencyMatters.has(matterId))
      : null,
  };
}

/**
 * Pull + classify a year's time entries for the given users (work dates
 * `year`-01-01 .. `endDate` inclusive). One /activities pull per user, one bulk
 * /matters pull for the client map, plus one matter lookup per
 * placeholder-candidate matter.
 */
export async function classifyYtdTimeEntries(opts: {
  year: number;
  endDate: string;
  userIds: number[];
  /** Apply the firm-internal reclassification. Defaults to TRUE. */
  excludeInternal?: boolean;
  /** Tag entries on Contingency-flagged matters (one extra /matters pull). Default false. */
  withContingency?: boolean;
}): Promise<ClassifiedTimeEntry[]> {
  const startDate = `${opts.year}-01-01`;
  const excludeInternal = opts.excludeInternal !== false;

  // Only needed for rule (a); skipped entirely on the legacy raw path so
  // exclude_internal=false costs exactly what it did before.
  const clientByMatter = excludeInternal ? await buildMatterClientMap() : undefined;
  const contingencyMatters = opts.withContingency ? await buildContingencyMatterSet() : null;

  const raw: RawTimeEntry[] = [];
  for (const userId of opts.userIds) {
    let acts: any[] = [];
    try {
      acts = await fetchAllPages<any>("/activities", {
        type: "TimeEntry",
        fields: CLASSIFIER_ACTIVITY_FIELDS,
        user_id: userId,
        created_since: `${startDate}T00:00:00+00:00`,
      });
    } catch (e: any) {
      console.warn(`[Goals] activity pull failed for user ${userId}: ${e?.message ?? e}`);
      continue;
    }
    for (const a of acts) {
      if (!a?.date || a.date < startDate || a.date > opts.endDate) continue;
      raw.push(toRawTimeEntry(a, userId, clientByMatter, contingencyMatters));
    }
  }

  const excludedIds = await findPlaceholderEntryIds(raw);
  const classified = classifyRawEntries(raw, excludedIds, { excludeInternal });

  if (excludeInternal) {
    const t = sumTotals(classified);
    if (t.internalHours > 0.05) {
      console.log(`[Goals] internal-time adjustment: ${t.internalHours.toFixed(1)}h moved from billable to nonbillable (firm-self-client ${t.firmSelfClientHours.toFixed(1)}h, $0 rate+amount ${t.zeroValueHours.toFixed(1)}h); billable ${t.billableRaw.toFixed(1)}h raw → ${t.billable.toFixed(1)}h adjusted`);
      if (t.firmSelfClientRatedHours > 0.05) {
        console.warn(`[Goals] ${t.firmSelfClientRatedHours.toFixed(1)}h of the firm-self-client reclassification carried a RATE — likely real client work filed under the firm's own client (e.g. 02671-Anike, 01537-Mediation Services), not internal time. Review whether those matters need a rule (a) exception.`);
      }
    }
  }
  return classified;
}

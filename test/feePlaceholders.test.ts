import { describe, it, expect, vi, beforeEach } from "vitest";

const activities: Record<number, any[]> = {};
const matters: Record<number, any> = {};
vi.mock("../src/clio/pagination", () => ({
  fetchAllPages: vi.fn(async (_path: string, params: any) => activities[params.user_id] ?? []),
  rawGetSingle: vi.fn(async (path: string) => {
    const id = Number(path.split("/").pop());
    if (!matters[id]) throw new Error("404");
    return { data: matters[id] };
  }),
  downloadReport: vi.fn(),
  rawPostSingle: vi.fn(),
}));

import { findFeePlaceholders, feePlaceholderKeys, buildExcludedHoursByMonth } from "../src/dashboard/excludedHours";
import { placeholderKey } from "../src/clio/reportCsv";

const NRN = 348755029;
const roster = [{ initials: "NRN", name: "Nicholas Noe", user_id: NRN }] as any;
const GHOLSTON_ID = 1621883794;
const GHOLSTON = "02681-Gholston Sr., Ronald - Estate of";
const act = (date: string, hrs: number, price: number, matterId: number) => ({
  date, quantity: hrs * 3600, rounded_quantity: hrs * 3600, price, non_billable: false,
  matter: { id: matterId }, user: { id: NRN },
});

beforeEach(() => {
  activities[NRN] = [
    act("2025-04-10", 0.2, 400, GHOLSTON_ID),
    act("2025-04-11", 0.4, 400, 42),
    act("2025-04-12", 0.6, 400, 42),
    act("2025-04-16", 1.0, 56187.98, GHOLSTON_ID), // contingency placeholder
    act("2025-04-17", 1.0, 350, 42),               // off-rate 1.0h on an hourly matter
  ];
  matters[GHOLSTON_ID] = {
    id: GHOLSTON_ID, display_number: GHOLSTON, practice_area: { name: "Estate Litigation" },
    custom_field_values: [{ field_name: "Contingency", value: true }],
  };
  matters[42] = { id: 42, display_number: "00042-Hourly", practice_area: { name: "Probate" }, custom_field_values: [] };
});

describe("findFeePlaceholders", () => {
  it("returns only the matter-gated placeholder, with its date and matter number", async () => {
    const found = await findFeePlaceholders(2025, 4, roster, { months: [4] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ uid: NRN, month: 4, date: "2025-04-16", rate: 56187.98, matterNumber: GHOLSTON });
  });

  it("keeps buildExcludedHoursByMonth's month x user totals unchanged", async () => {
    expect(await buildExcludedHoursByMonth(2025, 4, roster, { months: [4] })).toEqual({ 4: { [NRN]: 1 } });
  });

  it("yields keys that match the Realization-report row form", async () => {
    const keys = await feePlaceholderKeys(2025, [4], roster);
    expect([...keys]).toEqual([placeholderKey(NRN, "2025-04-16", GHOLSTON, 56187.98)]);
  });

  it("fails safe when a matter lookup fails: nothing stripped", async () => {
    delete matters[GHOLSTON_ID];
    expect(await feePlaceholderKeys(2025, [4], roster)).toEqual(new Set());
  });
});

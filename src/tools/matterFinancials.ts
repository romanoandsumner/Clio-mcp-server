import { z } from "zod/v4";
import { round2 } from "../utils/num";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import { isTrustAccount } from "../domain/trust";
import { fetchAllocations, classifyAllocation, summarizePayments } from "./payments";

const MATTER_FIELDS =
  "id,display_number,description,status,open_date,billing_method,responsible_attorney{id,name},client{id,name},practice_area{name}";

// Per Clio docs, BankTransaction fields are well-defined: id, date, amount
// (signed), description, transaction_type, funds_in, funds_out, plus
// matter, bank_account, bill, client, allocation relations.
const BANK_TX_FIELDS =
  "id,date,amount,funds_in,funds_out,description,transaction_type,source,matter{id},bank_account{id,name,type},bill{id}";

// trust_line_items resource fields per Clio docs.
const TRUST_LINE_FIELDS =
  "id,date,total,note,bill{id},matter{id,display_number,client}";

const TIME_FIELDS =
  "id,date,quantity,rounded_quantity,price,note,user{id,name},bill{id,state}";

const EXPENSE_FIELDS = "id,date,price,note,user{id,name},bill{id,state}";

const BILL_FIELDS = "id,number,issued_at,due_at,balance,total,kind,state";


function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

export function registerMatterFinancialsTools(server: McpServer): void {
  server.tool(
    "get_matter_financial_summary",
    "USE FOR: everything about ONE matter's money in one call. Trust balance (from the trust bank-account ledger, matches the Clio UI); WIP split into truly-unbilled vs draft-billed; open AR (revenue_kind fee invoices only; trust funding requests excluded); and `collected`: billed to date, paid to date (credits and voided allocations excluded), paid from trust, credits to date, and last payment date. For the individual payments behind `collected` use get_payments; for firm-wide views use get_ar_aging, get_trust_balances or get_wip_report.",
    {
      matter_id: z.coerce.number().describe("Clio matter ID"),
      trust_history_limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max number of recent trust transactions to include (default 10)"),
      include_unbilled_detail: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include individual unbilled time/expense entries (default false — totals only)"),
    },
    async (params) => {
      try {
        const matterId = params.matter_id;

        const matterRes = await rawGetSingle(`/matters/${matterId}`, {
          fields: MATTER_FIELDS,
        });
        const matter = matterRes.data;
        const clientId = matter?.client?.id;

        // Per Clio's BankTransaction docs: list endpoint is
        // /bank_transactions, supports matter_id and bank_account_id
        // filters. Pull all matter-scoped bank transactions; we'll filter
        // to trust accounts after we know which bank_account ids are trust.
        const bankAccountsPromise = fetchAllPages<any>("/bank_accounts", {
          fields: "id,name,type",
        }).catch(() => [] as any[]);

        const bankTransactionsPromise = fetchAllPages<any>("/bank_transactions", {
          matter_id: matterId,
          fields: BANK_TX_FIELDS,
        }).catch(() => [] as any[]);

        // trust_line_items kept as a secondary source / for the recent
        // ledger history (deposits with notes and bill_ids — useful detail
        // even though the balance comes from bank_transactions).
        const trustLineItemsPromise = fetchAllPages<any>("/trust_line_items", {
          matter_id: matterId,
          fields: TRUST_LINE_FIELDS,
        }).catch(() => [] as any[]);

        const timePromise = fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          billed: false,
          matter_id: matterId,
          fields: TIME_FIELDS,
        });

        const expensePromise = fetchAllPages<any>("/activities", {
          type: "ExpenseEntry",
          billed: false,
          matter_id: matterId,
          fields: EXPENSE_FIELDS,
        });

        const draftBillsPromise = fetchAllPages<any>("/bills", {
          matter_id: matterId,
          state: "draft",
          fields: BILL_FIELDS,
        });

        const outstandingBillsPromise = fetchAllPages<any>("/bills", {
          matter_id: matterId,
          state: "awaiting_payment",
          fields: BILL_FIELDS,
        });

        // For the `collected` block: paid bills (billed-to-date) and every
        // payment/credit allocation on the matter. Failures degrade to a note
        // rather than sinking the whole snapshot.
        const paidBillsPromise = fetchAllPages<any>("/bills", {
          matter_id: matterId,
          state: "paid",
          fields: BILL_FIELDS,
        }).catch(() => null);
        const allocationsPromise = fetchAllocations({ matter_id: matterId }).catch((e: any) => ({ error: e?.message ?? String(e) }));

        const [
          bankAccounts,
          bankTransactions,
          trustLineItems,
          timeEntries,
          expenseEntries,
          draftBills,
          outstandingBills,
          paidBills,
          allocationsResult,
        ] = await Promise.all([
          bankAccountsPromise,
          bankTransactionsPromise,
          trustLineItemsPromise,
          timePromise,
          expensePromise,
          draftBillsPromise,
          outstandingBillsPromise,
          paidBillsPromise,
          allocationsPromise,
        ]);

        const today = new Date();

        // --- Trust ---
        const trustBankAccountIds = new Set<number>(
          bankAccounts
            .filter(isTrustAccount)
            .map((a: any) => a.id)
            .filter((id: any): id is number => typeof id === "number")
        );

        const trustTransactions = bankTransactions.filter((t: any) =>
          t?.bank_account?.id != null
            ? trustBankAccountIds.has(t.bank_account.id)
            : false
        );

        // amount is signed per Clio docs. Sum it directly.
        const trustBalance = trustTransactions.reduce(
          (s: number, t: any) => s + (typeof t.amount === "number" ? t.amount : 0),
          0
        );

        // Funds-in / funds-out totals, since the docs expose them as
        // direction-specific amounts. Useful diagnostic.
        const fundsInTotal = trustTransactions.reduce(
          (s: number, t: any) => s + (t.funds_in || 0),
          0
        );
        const fundsOutTotal = trustTransactions.reduce(
          (s: number, t: any) => s + (t.funds_out || 0),
          0
        );

        const sortedTrustTransactions = [...trustTransactions].sort((a: any, b: any) =>
          (b.date || "").localeCompare(a.date || "")
        );

        let lastDeposit: string | null = null;
        let lastDisbursement: string | null = null;
        for (const t of sortedTrustTransactions) {
          const a = t.amount || 0;
          if (a > 0 && !lastDeposit) lastDeposit = t.date;
          if (a < 0 && !lastDisbursement) lastDisbursement = t.date;
        }
        const lastTrustActivity = sortedTrustTransactions[0]?.date ?? null;
        const trustDormancyDays = lastTrustActivity
          ? daysBetween(today, new Date(lastTrustActivity))
          : null;

        const trustFlags: string[] = [];
        if (trustBalance < 500) trustFlags.push("LOW_BALANCE");
        if (trustDormancyDays !== null && trustDormancyDays > 90) {
          trustFlags.push("DORMANT");
        }

        const limit = Math.max(0, params.trust_history_limit ?? 10);
        const recentTrust = sortedTrustTransactions.slice(0, limit).map((t: any) => ({
          id: t.id,
          date: t.date,
          amount: round2(t.amount || 0),
          description: t.description ?? null,
          transaction_type: t.transaction_type ?? null,
          source: t.source ?? null,
          bank_account: t.bank_account?.name ?? null,
          bill_id: t.bill?.id ?? null,
        }));

        const trustLineItemsBalance = trustLineItems.reduce(
          (s: number, e: any) => s + (e.total || 0),
          0
        );

        // --- WIP buckets ---
        let unbilledHours = 0;
        let unbilledTimeValue = 0;
        let oldestUnbilledDate: string | null = null;
        const unbilledTimeDetail: any[] = [];
        for (const e of timeEntries) {
          if (e.bill?.id != null) continue;
          const hours = (e.rounded_quantity ?? e.quantity ?? 0) / 3600;
          const value = hours * (e.price || 0);
          unbilledHours += hours;
          unbilledTimeValue += value;
          if (!oldestUnbilledDate || (e.date && e.date < oldestUnbilledDate)) {
            oldestUnbilledDate = e.date;
          }
          if (params.include_unbilled_detail) {
            unbilledTimeDetail.push({
              id: e.id,
              date: e.date,
              hours: round2(hours),
              rate: e.price,
              amount: round2(value),
              description: e.note,
              timekeeper: e.user,
            });
          }
        }

        let unbilledExpenses = 0;
        const unbilledExpenseDetail: any[] = [];
        for (const e of expenseEntries) {
          if (e.bill?.id != null) continue;
          unbilledExpenses += e.price || 0;
          if (!oldestUnbilledDate || (e.date && e.date < oldestUnbilledDate)) {
            oldestUnbilledDate = e.date;
          }
          if (params.include_unbilled_detail) {
            unbilledExpenseDetail.push({
              id: e.id,
              date: e.date,
              amount: round2(e.price || 0),
              description: e.note,
              user: e.user,
            });
          }
        }

        const unbilledTotal = unbilledTimeValue + unbilledExpenses;

        const draftBillTotal = draftBills.reduce(
          (s: number, b: any) => s + (b.total || 0),
          0
        );
        const draftBillSummary = draftBills.map((b: any) => ({
          bill_id: b.id,
          bill_number: b.number,
          total: round2(b.total || 0),
          balance: round2(b.balance || 0),
        }));

        const combinedWip = unbilledTotal + draftBillTotal;

        const wipDaysSinceOldest = oldestUnbilledDate
          ? daysBetween(today, new Date(oldestUnbilledDate))
          : null;
        const wipFlags: string[] = [];
        if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 60) wipFlags.push("RED");
        else if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 30) wipFlags.push("YELLOW");

        // --- AR ---
        // AR = revenue_kind fee bills only. A trust_kind bill is a trust/retainer
        // funding request (advance deposit), not a receivable; any other
        // (unexpected) kind is excluded and surfaced rather than counted as AR.
        let arBalance = 0;
        let oldestDueDate: string | null = null;
        const arBills = outstandingBills.filter((b: any) => {
          if (b.kind === "trust_kind") return false;
          if (b.kind !== "revenue_kind") {
            console.warn(`[get_matter_financial_summary] excluding bill ${b.number ?? b.id} from AR — unexpected kind=${JSON.stringify(b.kind)}`);
            return false;
          }
          return true;
        });
        const outstanding = arBills.map((b: any) => {
          const balance = b.balance || 0;
          arBalance += balance;
          const dueRef = b.due_at || b.issued_at;
          if (dueRef && (!oldestDueDate || dueRef < oldestDueDate)) {
            oldestDueDate = dueRef;
          }
          const dueDate = dueRef ? new Date(dueRef) : null;
          const daysOutstanding = dueDate
            ? Math.max(daysBetween(today, dueDate), 0)
            : null;
          return {
            bill_id: b.id,
            bill_number: b.number,
            issued_at: b.issued_at,
            due_at: b.due_at,
            total: b.total,
            balance: round2(balance),
            days_outstanding: daysOutstanding,
            state: b.state,
          };
        });
        outstanding.sort(
          (a: any, b: any) => (b.days_outstanding ?? 0) - (a.days_outstanding ?? 0)
        );

        const oldestArDays = oldestDueDate
          ? Math.max(daysBetween(today, new Date(oldestDueDate)), 0)
          : null;
        const arFlags: string[] = [];
        if (oldestArDays !== null && oldestArDays > 90) arFlags.push("OVER_90");
        else if (oldestArDays !== null && oldestArDays > 60) arFlags.push("OVER_60");
        else if (oldestArDays !== null && oldestArDays > 30) arFlags.push("OVER_30");

        const totalExposure = round2(combinedWip + arBalance);

        // --- Collected ---
        // Billed to date = issued fee invoices (open + paid). Paid to date excludes
        // credits and voided allocations; see tools/payments.ts for why both matter.
        const issuedFeeBills = [...outstandingBills, ...(paidBills ?? [])].filter((b: any) => b.kind === "revenue_kind");
        let collected: any;
        if ("error" in allocationsResult) {
          collected = { error: `Could not read payments: ${allocationsResult.error}` };
        } else {
          const rows = allocationsResult.classified
            ? allocationsResult.rows.filter((a: any) => !a.voided_at)
            : allocationsResult.rows;
          const pay = summarizePayments(rows.map((a: any) => ({ amount: a.amount, date: a.date, source: classifyAllocation(a) })));
          collected = {
            billed_to_date: paidBills ? round2(issuedFeeBills.reduce((s: number, b: any) => s + (b.total || 0), 0)) : null,
            paid_to_date: pay.total_paid,
            paid_from_trust: pay.by_source.trust,
            credits_to_date: pay.total_credits,
            last_payment_date: pay.last_payment_date,
            payment_count: pay.payment_count,
            classification_available: allocationsResult.classified,
            ...(allocationsResult.classified
              ? {}
              : { warning: "Clio did not return void/credit detail; paid_to_date may include voided allocations and credits." }),
          };
        }

        const result: any = {
          matter: {
            id: matter?.id,
            display_number: matter?.display_number,
            description: matter?.description,
            status: matter?.status,
            client: matter?.client,
            responsible_attorney: matter?.responsible_attorney,
            practice_area: matter?.practice_area,
            billing_method: matter?.billing_method,
            open_date: matter?.open_date,
          },
          trust: {
            balance: round2(trustBalance),
            balance_scope: "matter",
            balance_source: "bank_transactions.matter_id_on_trust_accounts",
            funds_in_total: round2(fundsInTotal),
            funds_out_total: round2(fundsOutTotal),
            client_id: clientId ?? null,
            trust_bank_account_ids: Array.from(trustBankAccountIds),
            trust_bank_account_names: bankAccounts
              .filter((a: any) => trustBankAccountIds.has(a.id))
              .map((a: any) => a.name),
            matter_bank_transactions_count: bankTransactions.length,
            trust_transactions_count: trustTransactions.length,
            // Diagnostic: trust_line_items sum is the deposits-only legacy
            // view (Clio's UI uses bank_transactions for the actual balance).
            trust_line_items_sum: round2(trustLineItemsBalance),
            trust_line_items_count: trustLineItems.length,
            last_deposit_date: lastDeposit,
            last_disbursement_date: lastDisbursement,
            last_activity_date: lastTrustActivity,
            days_since_last_activity: trustDormancyDays,
            flags: trustFlags,
            recent_transactions: recentTrust,
          },
          wip: {
            unbilled_hours: round2(unbilledHours),
            unbilled_time_value: round2(unbilledTimeValue),
            unbilled_expenses: round2(unbilledExpenses),
            unbilled_total: round2(unbilledTotal),
            draft_bill_count: draftBills.length,
            draft_bill_total: round2(draftBillTotal),
            draft_bills: draftBillSummary,
            combined_wip_value: round2(combinedWip),
            time_entry_count: timeEntries.length,
            expense_entry_count: expenseEntries.length,
            oldest_unbilled_entry_date: oldestUnbilledDate,
            days_since_oldest_unbilled: wipDaysSinceOldest,
            flags: wipFlags,
          },
          ar: {
            balance: round2(arBalance),
            outstanding_bill_count: outstanding.length,
            oldest_outstanding_due_date: oldestDueDate,
            oldest_outstanding_days: oldestArDays,
            flags: arFlags,
            outstanding_bills: outstanding,
          },
          collected,
          totals: {
            trust_balance: round2(trustBalance),
            wip_value: round2(combinedWip),
            ar_balance: round2(arBalance),
            wip_plus_ar: totalExposure,
          },
        };

        if (params.include_unbilled_detail) {
          result.wip.unbilled_time_entries = unbilledTimeDetail;
          result.wip.unbilled_expense_entries = unbilledExpenseDetail;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

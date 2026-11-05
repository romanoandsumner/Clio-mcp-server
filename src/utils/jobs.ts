// ============================================================
// Background-job registry for long-running tools
// (download_dashboard_update, download_all_weekly_goals, and the Clio report
// tools via withBackgroundFallback).
// ============================================================

// These tools can take several minutes (a revenue report or goals workbook per
// timekeeper), well past the MCP client's ~180s timeout. So they run as
// detached jobs: the tool returns a job_id immediately and the work
// continues server-side; get_dashboard_status reports progress/result. The Map
// is a module singleton, so it persists across tool calls for the life of the
// server process (jobs are lost only if the process restarts).
export type DashJob = {
  id: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at?: string;
  result?: any;
  error?: string;
};
export const dashboardJobs = new Map<string, DashJob>();

// The MCP client gives up on a tool call after ~60s. Inline budget stays well
// under that so a slow call can still hand back a job_id in time.
export const INLINE_BUDGET_MS = 45_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Wrap a tool handler so it never hits the client timeout: if the work finishes
 * within `budgetMs` its result is returned as usual; otherwise the call returns
 * a job_id immediately, the work keeps running server-side, and the full result
 * is read later with get_dashboard_status. Used by the Clio report tools, whose
 * report generation can run past the client's timeout on a slow day.
 */
export function withBackgroundFallback<P>(
  prefix: string,
  handler: (params: P) => Promise<ToolResult>,
  budgetMs: number = INLINE_BUDGET_MS,
): (params: P) => Promise<ToolResult> {
  return async (params: P) => {
    const work = handler(params).catch((err: any): ToolResult => ({
      content: [{ type: "text", text: JSON.stringify({ error: true, message: String(err?.message ?? err) }) }],
      isError: true,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); });
    const first = await Promise.race([work, timedOut]);
    clearTimeout(timer);
    if (first !== "timeout") return first;

    const jobId = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const job: DashJob = { id: jobId, status: "running", started_at: new Date().toISOString() };
    dashboardJobs.set(jobId, job);
    pruneDashboardJobs();
    work.then((res) => {
      job.result = res;
      job.status = res.isError ? "error" : "done";
      if (res.isError) job.error = res.content?.[0]?.text;
      job.finished_at = new Date().toISOString();
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          job_id: jobId,
          status: "running",
          message: `Still generating the Clio report after ${Math.round(budgetMs / 1000)}s, so it is continuing in the background. Poll get_dashboard_status with this job_id for the full result.`,
        }),
      }],
    };
  };
}
export function pruneDashboardJobs() {
  const now = Date.now();
  for (const [id, j] of dashboardJobs) {
    if (j.finished_at && now - new Date(j.finished_at).getTime() > 2 * 3600 * 1000) dashboardJobs.delete(id);
  }
  while (dashboardJobs.size > 50) {
    const oldest = dashboardJobs.keys().next().value;
    if (oldest === undefined) break;
    dashboardJobs.delete(oldest);
  }
}

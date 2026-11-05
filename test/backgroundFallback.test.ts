import { describe, it, expect } from "vitest";
import { withBackgroundFallback, dashboardJobs } from "../src/utils/jobs";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withBackgroundFallback", () => {
  it("returns the result inline when the work finishes within the budget", async () => {
    const handler = withBackgroundFallback("t", async (p: { n: number }) => ok(`done ${p.n}`), 200);
    const res = await handler({ n: 1 });
    expect(res.content[0].text).toBe("done 1");
  });

  it("hands back a job_id when the work outlasts the budget, then records the result on the job", async () => {
    const handler = withBackgroundFallback("t", async () => { await sleep(80); return ok("late result"); }, 20);
    const res = await handler({});
    const { job_id, status } = JSON.parse(res.content[0].text);
    expect(status).toBe("running");
    expect(dashboardJobs.get(job_id)?.status).toBe("running");
    await sleep(120);
    const job = dashboardJobs.get(job_id)!;
    expect(job.status).toBe("done");
    expect(job.result.content[0].text).toBe("late result"); // get_dashboard_status reads content[0].text
    expect(job.finished_at).toBeDefined();
  });

  it("marks a slow call that ends in an error result as an error job", async () => {
    const handler = withBackgroundFallback("t", async () => {
      await sleep(60);
      return { content: [{ type: "text" as const, text: '{"error":true,"message":"report failed"}' }], isError: true };
    }, 10);
    const { job_id } = JSON.parse((await handler({})).content[0].text);
    await sleep(100);
    const job = dashboardJobs.get(job_id)!;
    expect(job.status).toBe("error");
    expect(job.error).toContain("report failed");
  });

  it("turns a thrown error into an error result instead of rejecting", async () => {
    const handler = withBackgroundFallback("t", async () => { throw new Error("boom"); }, 50);
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toBe("boom");
  });
});

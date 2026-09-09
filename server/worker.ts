// Job worker. Runs inside the Fly process next to the WS relay (started from
// live.ts) or standalone via worker-main.ts for local runs.

import { claimNextJob, completeJob, failJob } from "../lib/jobs.js";
import { generateFreeReport } from "../lib/engine.js";
import { extractObservations } from "../lib/extract.js";
import { extractFullObservations } from "../lib/extract-full.js";
import { generateFullReport } from "../lib/engine-full.js";

const POLL_MS = 5_000;

async function handle(jobId: string, type: string, assessmentId: string): Promise<void> {
  if (type === "generate_free_report") return generateFreeReport(assessmentId);
  if (type === "extract_observations") return extractObservations(assessmentId);
  if (type === "extract_full_observations") return extractFullObservations(assessmentId);
  if (type === "generate_full_report") return generateFullReport(assessmentId);
  throw new Error(`unknown job type ${type}`);
}

export function startWorker(): void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const claimed = await claimNextJob();
        if (!claimed) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          continue;
        }
        const { id, job } = claimed;
        console.log(`[WORKER] start job=${id} attempt=${job.attempts}`);
        try {
          await handle(id, job.type, job.assessmentId);
          await completeJob(id);
          console.log(`[WORKER] done job=${id}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[WORKER] failed job=${id}:`, msg);
          await failJob(id, msg);
        }
      } catch (e) {
        console.error("[WORKER] loop error:", e);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }
  };
  void loop();
  void retentionSweep();
  setInterval(() => void retentionSweep(), 24 * 60 * 60 * 1000);
  void weeklyPricingRefresh();
  setInterval(() => void weeklyPricingRefresh(), 24 * 60 * 60 * 1000);
  console.log("[WORKER] started");
  process.on("SIGTERM", () => {
    stopped = true;
  });
}

// Checked daily, run weekly: re-verify allowlist tool pricing against the
// live vendor pages so "verified on" dates stay honest. The 6-day guard
// lives in config/global so deploy restarts don't re-run it.
async function weeklyPricingRefresh(): Promise<void> {
  try {
    const { adminDb } = await import("../lib/firebase-admin.js");
    const { FieldValue } = await import("firebase-admin/firestore");
    const ref = adminDb().collection("config").doc("global");
    const last = (await ref.get()).data()?.pricingRefreshAt;
    const lastMs = last?.toMillis?.() ?? 0;
    if (Date.now() - lastMs < 6 * 24 * 60 * 60 * 1000) return;
    await ref.set({ pricingRefreshAt: FieldValue.serverTimestamp() }, { merge: true });
    const { refreshToolPricing } = await import("../lib/pricing-refresh.js");
    await refreshToolPricing();
  } catch (e) {
    console.error("[PRICING] weekly refresh failed:", e);
  }
}

// Published policy: transcripts and audio are deleted 12 months after the
// call. Bounded batch per sweep; the daily interval catches up over time.
const RETENTION_DAYS = 365;

async function retentionSweep(): Promise<void> {
  try {
    const { adminDb } = await import("../lib/firebase-admin.js");
    const { FieldValue, Timestamp } = await import("firebase-admin/firestore");
    const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const db = adminDb();
    const old = await db
      .collection("assessments")
      .where("createdAt", "<", cutoff)
      .limit(20)
      .get();
    for (const doc of old.docs) {
      if (doc.data().transcriptPurgedAt) continue;
      const turns = await doc.ref.collection("transcript").get();
      for (const t of turns.docs) await t.ref.delete();
      await doc.ref.update({
        transcriptPurgedAt: FieldValue.serverTimestamp(),
        audioStoragePath: null,
      });
      console.log(`[RETENTION] purged transcript assessment=${doc.id} turns=${turns.size}`);
    }
  } catch (e) {
    console.error("[RETENTION] sweep failed:", e);
  }
}

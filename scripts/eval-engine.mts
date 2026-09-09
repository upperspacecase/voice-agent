// Engine regression suite (PRD §12 "Model quality"). Run before any prompt or
// model change:  npm run eval
//
// Each fixture is a messy-but-realistic intake; each invariant is a property
// that must hold for the report to be publishable. Failures print loudly and
// exit non-zero. This suite calls the real model — it measures behaviour, not
// mocks.

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config as loadDotenv } from "dotenv";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: join(REPO_ROOT, ".env.local"), quiet: true });

const { adminDb } = await import("../lib/firebase-admin.js");
const { generateFreeReport } = await import("../lib/engine.js");
const { FieldValue } = await import("firebase-admin/firestore");

interface Fixture {
  name: string;
  workflowId: string;
  timeRange: { minHoursPerWeek: number; maxHoursPerWeek: number } | null;
  process: string;
  owner: string | null;
  tools: string[];
  outcome: string | null;
  quotes: string[];
}

// Deliberately varied registers: rambling ASR-style speech, terse typing,
// no numbers, contradiction bait.
const FIXTURES: Fixture[] = [
  {
    name: "rambling-phone-style",
    workflowId: "lead_generation",
    timeRange: { minHoursPerWeek: 6, maxHoursPerWeek: 10 },
    process:
      "so um basically when someone enquires off the portal it uh it comes to my phone yeah and if im showing a house it just sits there til night... then i gotta remember who i texted back and who i didnt, theres no system really, i sorta keep it in my head and honestly stuff falls through, especially the ones that dont reply first go, nobody chases them a second time",
    owner: "me mostly",
    tools: ["phone", "whatsapp"],
    outcome: "leads get chased without me remembering",
    quotes: ["stuff falls through", "nobody chases them a second time"],
  },
  {
    name: "terse-no-numbers",
    workflowId: "transactions_paperwork",
    timeRange: null,
    process: "Chasing signatures. Printing for lawyer. Deadlines in my head. Nearly missed one twice.",
    owner: "me + admin",
    tools: ["email", "printer"],
    outcome: null,
    quotes: ["Deadlines in my head"],
  },
  {
    name: "implied-task-never-named",
    workflowId: "client_communication",
    timeRange: { minHoursPerWeek: 3, maxHoursPerWeek: 5 },
    process:
      "Every vendor rings me when they get nervous. I end up explaining the same market situation over and over, and after every conversation I have to remember to write down what I promised them, which I sometimes don't, and then next call I look silly.",
    owner: "me",
    tools: ["phone"],
    outcome: "vendors feel informed without calling me",
    quotes: ["explaining the same market situation over and over"],
  },
];

type Failure = { fixture: string; invariant: string; detail: string };
const failures: Failure[] = [];
const db = adminDb();

for (const f of FIXTURES) {
  const shareId = `EVAL${Math.abs(f.name.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100000}`;
  const ref = db.collection("assessments").doc();
  await ref.set({
    id: ref.id, shareId, schemaVersion: 1, tier: "free", channel: "form",
    selectedWorkflows: [f.workflowId],
    locale: { country: "NZ", timezone: null, currency: "USD" },
    parentAssessmentId: null, consentIds: [],
    firstName: "Eval", businessName: `EVAL ${f.name}`, website: null,
    location: "NZ", teamSize: "5-15", clientName: "Eval", clientEmail: null,
    industry: "real_estate", callerRole: null, status: "pending_processing",
    voiceSessionId: null, voiceSessionHandles: [], audioStoragePath: null,
    callStartedAt: null, callEndedAt: null, callDurationSec: null,
    headline: null, executiveSummary: null, fourDayPlan: null,
    promptVersionId: null, pipelineVersionId: null,
    createdAt: FieldValue.serverTimestamp(), completedAt: null, emailedAt: null,
    paidAt: null, amountPaidUsd: null, stripeCheckoutSessionId: null,
    stripePaymentIntentId: null, tayNotes: "EVAL FIXTURE",
  });
  await ref.collection("observations").add({
    id: "eval1", workflowId: f.workflowId, source: "form",
    currentProcess: f.process, owner: f.owner, tools: f.tools,
    timeRange: f.timeRange, desiredOutcome: f.outcome, verbatimQuotes: f.quotes,
    createdAt: FieldValue.serverTimestamp(),
  });

  // The production job queue retries transient model errors; the eval gets
  // the same courtesy so a capacity 503 doesn't read as an engine failure.
  let generated = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await generateFreeReport(ref.id);
      generated = true;
      break;
    } catch (e) {
      const msg = String(e);
      if (attempt < 4 && (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("429"))) {
        console.log(`[${f.name}] transient model error, retry ${attempt}/3 in ${attempt * 20}s`);
        await new Promise((r) => setTimeout(r, attempt * 20_000));
        continue;
      }
      failures.push({ fixture: f.name, invariant: "engine_completes", detail: msg.slice(0, 200) });
      break;
    }
  }
  if (!generated) {
    await cleanup(ref, shareId);
    continue;
  }
  const r = (await db.collection("publicReports").doc(shareId).get()).data()!;
  const rec = r.recommendation;
  const tasks = (r.tasks ?? []) as { label: string; status: string; support: string; timeRange: { maxHoursPerWeek: number } | null }[];

  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push({ fixture: f.name, invariant: name, detail });
  };

  check("tasks_found", tasks.length >= 2, `only ${tasks.length} tasks`);
  check("no_unsupported_shipped", tasks.every((t) => t.status === "grounded" || t.status === "inferred"),
    JSON.stringify(tasks.map((t) => t.status)));
  check("grounded_have_support", tasks.filter((t) => t.status === "grounded").every((t) => t.support.length > 0),
    "grounded task with empty support");
  check("some_grounding", tasks.some((t) => t.status === "grounded"), "no grounded tasks at all");
  if (f.timeRange) {
    check("recoverable_within_stated",
      rec.impact.recoverableRange.maxHoursPerWeek <= f.timeRange.maxHoursPerWeek,
      `recoverable ${rec.impact.recoverableRange.maxHoursPerWeek} > stated ${f.timeRange.maxHoursPerWeek}`);
    check("task_time_within_stated",
      tasks.every((t) => !t.timeRange || t.timeRange.maxHoursPerWeek <= f.timeRange!.maxHoursPerWeek),
      "task time exceeds stated workflow time");
  } else {
    check("no_stated_time_low_confidence_or_flagged",
      rec.confidence.level === "low" || r.flaggedForReview === true,
      `no stated time but confidence=${rec.confidence.level} flagged=${r.flaggedForReview}`);
  }
  check("price_only_when_verified",
    rec.cost.recurringMonthlyUsd == null || rec.cost.sourceDate != null,
    `price ${rec.cost.recurringMonthlyUsd} without sourceDate`);
  check("range_is_range",
    rec.impact.annualValueRange.minUsd <= rec.impact.annualValueRange.maxUsd,
    JSON.stringify(rec.impact.annualValueRange));

  console.log(`[${f.name}] tasks=${tasks.length} (${tasks.map((t) => t.status[0]).join("")}) ` +
    `recoverable=${rec.impact.recoverableRange.minHoursPerWeek}-${rec.impact.recoverableRange.maxHoursPerWeek} ` +
    `tool=${rec.toolOrApproach ?? "none"} flagged=${r.flaggedForReview} ${r.flagReasons?.join(",") || ""}`);

  await cleanup(ref, shareId);
}

async function cleanup(ref: FirebaseFirestore.DocumentReference, shareId: string) {
  const obs = await ref.collection("observations").get();
  for (const d of obs.docs) await d.ref.delete();
  const recs = await ref.collection("recommendations").get();
  for (const d of recs.docs) await d.ref.delete();
  await ref.delete();
  await db.collection("publicReports").doc(shareId).delete();
}

if (failures.length) {
  console.error(`\nEVAL FAILED — ${failures.length} invariant violation(s):`);
  for (const f of failures) console.error(`  [${f.fixture}] ${f.invariant}: ${f.detail}`);
  process.exit(1);
}
console.log(`\nEVAL PASSED — ${FIXTURES.length} fixtures, all invariants hold.`);

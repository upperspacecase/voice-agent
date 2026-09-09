// Free-assessment engine (PRD §7.5, §10). Division of labour: the model reads
// the customer's observations and proposes the task, disposition and
// recoverable-hours range; THIS CODE does every dollar calculation, clamps
// ranges against what the customer stated, and decides whether the result is
// safe to auto-send. The model is never trusted with arithmetic or benchmarks.

import { GoogleGenAI, Type } from "@google/genai";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { getWorkflow } from "./taxonomy";
import type {
  Disposition,
  EngineRecommendation,
  HoursRange,
  WorkflowObservation,
} from "./assessment-schema";
import { logEvent } from "./events";
import { sendAdminNotification, sendFreeReportDelivery } from "./email";
import { getVerifiedTools, matchVerifiedTool, type VerifiedTool } from "./tool-allowlist";
import { verifyGrounding, anchorQuote, normLabel, type VerifiedTask } from "./verify-grounding";

const REPORT_MODEL = process.env.REPORT_MODEL ?? "gemini-3-flash-preview";

// Visible, editable defaults (§10.1). No hidden multipliers.
const DEFAULT_WORKING_WEEKS = 46;
const DEFAULT_LOADED_HOURLY_USD = 60;

// Flag rules: when any of these trips, the report holds for human review
// instead of auto-sending (FR-43).
const FLAG_ANNUAL_MAX_USD = 100_000;

const OUTPUT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tasks: {
      type: Type.ARRAY,
      description: "Every distinct task the customer described inside this workflow, up to 6. Only tasks their answers actually mention.",
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "Short task name in the customer's language" },
          evidenceQuote: { type: Type.STRING, description: "EXACT verbatim phrase from the customer's answers that this task comes from" },
          timeKnown: { type: Type.BOOLEAN, description: "Did the customer state time for this specific task?" },
          timeMinHoursPerWeek: { type: Type.NUMBER },
          timeMaxHoursPerWeek: { type: Type.NUMBER },
        },
        required: ["label", "evidenceQuote", "timeKnown", "timeMinHoursPerWeek", "timeMaxHoursPerWeek"],
      },
    },
    taskLabel: { type: Type.STRING, description: "The single task worth improving, in the customer's language" },
    currentStateSummary: { type: Type.STRING, description: "One or two sentences summarising the customer's stated process" },
    disposition: { type: Type.STRING, enum: ["keep_human", "automate", "ai", "hand_off", "stop"] },
    recommendation: { type: Type.STRING, description: "Plain-language action and why it fits this team" },
    toolOrApproach: { type: Type.STRING, description: "Specific product, integration, process or role. Empty string if none." },
    setupSteps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-5 ordered steps" },
    recurringMonthlyCostUsd: { type: Type.NUMBER, description: "Estimated recurring tool cost per month in USD, 0 if none" },
    recoverableMinHoursPerWeek: { type: Type.NUMBER },
    recoverableMaxHoursPerWeek: { type: Type.NUMBER },
    customerQuotes: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Short verbatim phrases from the customer's own answers" },
    confidenceLevel: { type: Type.STRING, enum: ["high", "medium", "low"] },
    confidenceReason: { type: Type.STRING },
    agentPrompt: { type: Type.STRING, description: "A prompt the customer can paste into an AI agent to start the setup" },
    nextSteps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3 short actions for this week" },
  },
  required: [
    "tasks", "taskLabel", "currentStateSummary", "disposition", "recommendation",
    "toolOrApproach", "setupSteps", "recurringMonthlyCostUsd",
    "recoverableMinHoursPerWeek", "recoverableMaxHoursPerWeek",
    "customerQuotes", "confidenceLevel", "confidenceReason", "agentPrompt",
    "nextSteps",
  ],
} as const;

interface ModelTask {
  label: string;
  evidenceQuote: string;
  timeKnown: boolean;
  timeMinHoursPerWeek: number;
  timeMaxHoursPerWeek: number;
}

interface ModelOutput {
  tasks: ModelTask[];
  taskLabel: string;
  currentStateSummary: string;
  disposition: Disposition;
  recommendation: string;
  toolOrApproach: string;
  setupSteps: string[];
  recurringMonthlyCostUsd: number;
  recoverableMinHoursPerWeek: number;
  recoverableMaxHoursPerWeek: number;
  customerQuotes: string[];
  confidenceLevel: "high" | "medium" | "low";
  confidenceReason: string;
  agentPrompt: string;
  nextSteps: string[];
}

function buildPrompt(args: {
  workflowLabel: string;
  teamSize: string | null;
  country: string | null;
  observations: WorkflowObservation[];
  verifiedTools: VerifiedTool[];
}): string {
  const obs = args.observations
    .map(
      (o) =>
        `Process, in their words: ${o.currentProcess}\n` +
        `Who does it: ${o.owner ?? "not stated"}\n` +
        `Tools: ${o.tools.length ? o.tools.join(", ") : "not stated"}\n` +
        `Time: ${o.timeRange ? `${o.timeRange.minHoursPerWeek}-${o.timeRange.maxHoursPerWeek} hrs/week (their estimate)` : "they were not sure"}\n` +
        `What fixed looks like to them: ${o.desiredOutcome ?? "not stated"}` +
        (o.verbatimQuotes.length ? `\nVerbatim quotes: ${o.verbatimQuotes.map((q) => JSON.stringify(q)).join(", ")}` : ""),
    )
    .join("\n---\n");

  return [
    `You are the assessment engine for Hours. A real-estate team described ONE workflow: ${args.workflowLabel}.`,
    `Team size: ${args.teamSize ?? "not stated"}. Country: ${args.country ?? "not stated"}.`,
    "",
    "Their answers:",
    obs,
    "",
    "First, map every distinct task the customer described inside this workflow (tasks array) — each MUST carry an exact verbatim evidenceQuote from their answers; a task you cannot quote does not exist. Give per-task time only when the customer stated it for that task; otherwise timeKnown=false.",
    "Then select the ONE task where a change creates the most recoverable time for the least setup effort, and produce a recommendation. taskLabel must match one of the tasks in the array.",
    "",
    "",
    args.verifiedTools.length
      ? [
          "Verified tools for this workflow (pricing confirmed against the live pricing page; PREFER one of these when a tool fits):",
          ...args.verifiedTools.map(
            (t) =>
              `- ${t.name}: ${t.fit}. Plans: ${t.plans.map((p) => `${p.plan} $${p.monthlyUsd}/mo (${p.note})`).join("; ")}. Free trial: ${t.freeTrial ?? "none"}.`,
          ),
        ].join("\n")
      : "No verified tools are on file for this workflow.",
    "",
    "Hard rules:",
    "- Use ONLY what the customer said. Do not invent industry averages, statistics, or facts about their business.",
    "- customerQuotes must be verbatim phrases from their answers, never paraphrased.",
    "- recoverable hours must be a defensible reduction of THEIR stated time, expressed as a range. If they were unsure of their time, keep the range small and set confidence to low.",
    "- Prefer a verified tool from the list above when one fits the problem. Recommending a tool NOT on the list is allowed only when none fits — and then describe the approach; its pricing will be shown as unverified.",
    "- Do not promise revenue gains. Time only.",
    "- The recommendation must be small enough to start this week.",
  ].join("\n");
}

function clampRecoverable(model: ModelOutput, stated: HoursRange | null): {
  range: HoursRange;
  clampedHard: boolean;
} {
  let min = Math.max(0, model.recoverableMinHoursPerWeek);
  let max = Math.max(min, model.recoverableMaxHoursPerWeek);
  let clampedHard = false;
  if (stated) {
    // Recoverable time cannot exceed the time the customer says they spend.
    if (max > stated.maxHoursPerWeek) {
      clampedHard = max > stated.maxHoursPerWeek * 1.5;
      max = stated.maxHoursPerWeek;
      min = Math.min(min, max);
    }
  }
  return { range: { minHoursPerWeek: min, maxHoursPerWeek: max }, clampedHard };
}

export async function generateFreeReport(assessmentId: string): Promise<void> {
  const db = adminDb();
  const ref = db.collection("assessments").doc(assessmentId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`assessment ${assessmentId} not found`);
  const a = snap.data() as Record<string, unknown>;

  const workflowId = (a.selectedWorkflows as string[] | undefined)?.[0];
  const workflow = workflowId ? getWorkflow(workflowId) : null;
  if (!workflow) throw new Error("no selected workflow");

  const obsSnap = await ref.collection("observations").get();
  const observations = obsSnap.docs.map((d) => d.data() as WorkflowObservation);
  if (observations.length === 0) throw new Error("no observations");

  const locale = (a.locale as { country?: string | null; currency?: string } | undefined) ?? {};
  const verifiedTools = await getVerifiedTools(workflow.id);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const prompt = buildPrompt({
    workflowLabel: workflow.label,
    teamSize: (a.teamSize as string | null) ?? null,
    country: locale.country ?? null,
    observations,
    verifiedTools,
  });

  const result = await ai.models.generateContent({
    model: REPORT_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: OUTPUT_SCHEMA,
      temperature: 0.3,
    },
  });
  const out = JSON.parse(result.text ?? "{}") as ModelOutput;

  // ---- Reliability layer: semantic grounding, not string matching. An
  // independent verifier judges each task against everything the customer
  // said: grounded (shown with an anchored verbatim passage), inferred
  // (shown, labelled as our inference), unsupported (never ships). ----
  const sourceText = observations
    .map((o) =>
      [o.currentProcess, o.desiredOutcome ?? "", ...o.verbatimQuotes].filter(Boolean).join("\n"),
    )
    .join("\n");
  const candidates = (out.tasks ?? []).filter((t) => t.label.trim()).slice(0, 6);
  const grounding = await verifyGrounding({
    sourceText,
    taskLabels: candidates.map((t) => t.label.trim()),
    recommendationSummary: `${out.taskLabel}: ${out.recommendation}`,
  });

  const statedMax = observations[0].timeRange?.maxHoursPerWeek ?? null;
  const tasks: VerifiedTask[] = [];
  let unsupportedCount = 0;
  for (const t of candidates) {
    const verdict = grounding.tasks.get(normLabel(t.label));
    if (!verdict || verdict.status === "unsupported") {
      unsupportedCount++;
      continue;
    }
    // Quotes shown to the customer are snapped to their real wording; if no
    // span anchors, the task survives as "inferred" rather than lying.
    let status = verdict.status;
    let support = verdict.support;
    if (status === "grounded") {
      const anchored = anchorQuote(verdict.support || t.evidenceQuote, sourceText);
      if (anchored) support = anchored;
      else {
        status = "inferred";
        support = verdict.support || "Implied by your description of this workflow.";
      }
    }
    const min = Math.max(0, t.timeMinHoursPerWeek);
    const max = Math.max(min, t.timeMaxHoursPerWeek);
    const capped = statedMax != null ? Math.min(max, statedMax) : max;
    tasks.push({
      label: t.label.trim(),
      status,
      support,
      timeRange: t.timeKnown ? { minHoursPerWeek: Math.min(min, capped), maxHoursPerWeek: capped } : null,
      examined: false,
    });
  }
  const chosenIdx = tasks.findIndex((t) => normLabel(t.label) === normLabel(out.taskLabel));
  if (chosenIdx >= 0) tasks[chosenIdx].examined = true;

  // ---- Deterministic calculation layer (§10.1) ----
  const stated = observations[0].timeRange ?? null;
  const { range: recoverable, clampedHard } = clampRecoverable(out, stated);
  const weeks = DEFAULT_WORKING_WEEKS;
  const hourly = DEFAULT_LOADED_HOURLY_USD;

  // Price truth: only a verified allowlist entry may put a dollar figure on a
  // tool. A model-guessed price is discarded, and the annual value is
  // recomputed without the unverified cost rather than shipping a number
  // built on one.
  const verified = matchVerifiedTool(out.toolOrApproach, verifiedTools);
  const verifiedMonthly = verified
    ? Math.min(...verified.plans.map((p) => p.monthlyUsd))
    : null;
  const effectiveMonthly = verified ? verifiedMonthly! : 0;
  const effectiveToolAnnual = effectiveMonthly * 12;
  const annualFinal = {
    minUsd: Math.max(0, Math.round(recoverable.minHoursPerWeek * weeks * hourly - effectiveToolAnnual)),
    maxUsd: Math.max(0, Math.round(recoverable.maxHoursPerWeek * weeks * hourly - effectiveToolAnnual)),
  };

  const flagReasons: string[] = [];
  if (out.confidenceLevel === "low") flagReasons.push("low_confidence");
  if (annualFinal.maxUsd > FLAG_ANNUAL_MAX_USD) flagReasons.push("implausible_annual_value");
  if (clampedHard) flagReasons.push("model_overshot_stated_time");
  if ((out.disposition === "automate" || out.disposition === "ai") && !out.toolOrApproach.trim())
    flagReasons.push("automation_without_approach");
  if (out.toolOrApproach.trim() && !verified) flagReasons.push("tool_not_verified");
  if (unsupportedCount >= 2) flagReasons.push("tasks_unsupported_by_answers");
  if (chosenIdx < 0) flagReasons.push("chosen_task_not_grounded");
  if (!grounding.recommendationSupported) flagReasons.push(`recommendation_refuted: ${grounding.recommendationConcern}`.slice(0, 120));
  const flagged = flagReasons.length > 0;

  const recommendation: EngineRecommendation = {
    id: `rec_${assessmentId}_1`,
    workflowId: workflow.id,
    taskLabel: out.taskLabel,
    currentState: out.currentStateSummary,
    disposition: out.disposition,
    recommendation: out.recommendation,
    toolOrApproach: verified ? verified.name : out.toolOrApproach.trim() || null,
    setupSteps: out.setupSteps.slice(0, 5),
    cost: {
      oneTimeUsd: null,
      recurringMonthlyUsd: verifiedMonthly,
      sourceDate: verified ? verified.sourceDate : null,
    },
    impact: {
      recoverableRange: recoverable,
      annualValueRange: annualFinal,
      revenueUpsideNote: null,
    },
    evidence: {
      customerQuotes: out.customerQuotes.slice(0, 4),
      externalSources: verified
        ? [{ title: `${verified.name} pricing`, url: verified.pricingUrl, date: verified.sourceDate }]
        : [],
      benchmarkState: "self_reported",
    },
    confidence: { level: out.confidenceLevel, reason: out.confidenceReason },
    agentPrompt: out.agentPrompt.trim() || null,
    assumptions: {
      workingWeeksPerYear: weeks,
      loadedHourlyCostUsd: hourly,
      currency: locale.currency ?? "USD",
    },
  };

  const markdown = renderMarkdown({
    workflowLabel: workflow.label,
    businessName: (a.businessName as string | null) ?? null,
    statedOutcome: observations[0].desiredOutcome,
    currentTimeRange: stated,
    recommendation,
    nextSteps: out.nextSteps.slice(0, 3),
  });

  await ref.collection("recommendations").doc(recommendation.id).set(recommendation);

  const shareId = a.shareId as string;
  await db.collection("publicReports").doc(shareId).set({
    kind: "free_v1",
    reportVersion: 1,
    assessmentId,
    clientName: (a.clientName as string | null) ?? "",
    businessName: (a.businessName as string | null) ?? "",
    workflowId: workflow.id,
    workflowLabel: workflow.label,
    statedOutcome: observations[0].desiredOutcome,
    currentTimeRange: stated,
    tasks,
    recommendation,
    nextSteps: out.nextSteps.slice(0, 3),
    markdown,
    flaggedForReview: flagged,
    flagReasons,
    generatedAt: FieldValue.serverTimestamp(),
  });

  await logEvent("report_generated", {
    assessmentId,
    meta: { kind: "free_v1", flagged, flagReasons: flagReasons.join(",") },
  });

  if (flagged) {
    await ref.update({ status: "manual_review" });
    await sendAdminNotification({
      businessName: (a.businessName as string | null) ?? "Unknown business",
      assessmentId,
      shareId,
    });
    return;
  }

  await ref.update({ status: "complete", completedAt: FieldValue.serverTimestamp() });
  const email = (a.clientEmail as string | null) ?? null;
  if (email) {
    await sendFreeReportDelivery({
      to: email,
      clientName: (a.clientName as string | null) ?? "",
      shareId,
      workflowLabel: workflow.label,
    });
    await ref.update({ emailedAt: FieldValue.serverTimestamp() });
    await logEvent("report_delivered", { assessmentId, meta: { kind: "free_v1" } });
  }
}

function renderMarkdown(args: {
  workflowLabel: string;
  businessName: string | null;
  statedOutcome: string | null;
  currentTimeRange: HoursRange | null;
  recommendation: EngineRecommendation;
  nextSteps: string[];
}): string {
  const r = args.recommendation;
  const hrs = args.currentTimeRange
    ? `${args.currentTimeRange.minHoursPerWeek}-${args.currentTimeRange.maxHoursPerWeek} hrs/week (customer estimate)`
    : "Customer was unsure";
  return [
    `# Hours Free Assessment${args.businessName ? ` — ${args.businessName}` : ""}`,
    "",
    `## Workflow examined`,
    args.workflowLabel,
    args.statedOutcome ? `\nStated outcome: ${args.statedOutcome}` : "",
    "",
    `## Current state`,
    r.currentState,
    `\nCurrent time: ${hrs}`,
    "",
    `## Recommendation — ${r.disposition.replace("_", " ")}`,
    r.recommendation,
    r.toolOrApproach
      ? `\nTool or approach: ${r.toolOrApproach}${
          r.cost.recurringMonthlyUsd != null && r.cost.sourceDate
            ? ` — from $${r.cost.recurringMonthlyUsd}/mo (pricing verified ${r.cost.sourceDate})`
            : " — pricing not verified; check the vendor's site"
        }`
      : "",
    "",
    `Recoverable (estimate): ${r.impact.recoverableRange.minHoursPerWeek}-${r.impact.recoverableRange.maxHoursPerWeek} hrs/week`,
    `Annual value (estimate): $${r.impact.annualValueRange.minUsd.toLocaleString()}-$${r.impact.annualValueRange.maxUsd.toLocaleString()}`,
    `Assumptions: ${r.assumptions.workingWeeksPerYear} working weeks/year, $${r.assumptions.loadedHourlyCostUsd}/hr loaded cost. All figures are estimates based on the customer's own answers (no external benchmark applied).`,
    `Confidence: ${r.confidence.level} — ${r.confidence.reason}`,
    "",
    `## Setup steps`,
    ...r.setupSteps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `## Next steps this week`,
    ...args.nextSteps.map((s, i) => `${i + 1}. ${s}`),
    ...(r.agentPrompt
      ? ["", "## Agent-ready prompt", "```", r.agentPrompt, "```"]
      : []),
    "",
    `---`,
    `Full Assessment ($497): all six workflows, up to three priority changes, 30-minute strategy call. https://gethours.org/#pricing`,
  ].join("\n");
}

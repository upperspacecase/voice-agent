// Semantic grounding for engine output. People describe their work in all
// sorts of ways, so nothing here compares strings for truth — an independent
// verifier pass judges whether each extracted task is entailed by what the
// customer said. Exact-quote *display* is handled separately by fuzzy
// anchoring: we snap the model's quote to the closest real passage and show
// that, so shown quotes are verbatim even when the extractor paraphrased.

import { GoogleGenAI, Type } from "@google/genai";

const REPORT_MODEL = process.env.REPORT_MODEL ?? "gemini-3-flash-preview";

export type GroundingStatus = "grounded" | "inferred" | "unsupported";

export interface VerifiedTask {
  label: string;
  status: GroundingStatus;
  // grounded: the anchored verbatim passage. inferred: the verifier's
  // one-line reasoning. unsupported: absent (task is dropped upstream).
  support: string;
  timeRange: { minHoursPerWeek: number; maxHoursPerWeek: number } | null;
  examined: boolean;
}

const VERIFY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "The task label being judged, copied exactly" },
          status: { type: Type.STRING, enum: ["grounded", "inferred", "unsupported"] },
          supportingPassage: {
            type: Type.STRING,
            description: "grounded: the passage of the customer's text that describes this task, as close to their wording as possible. inferred: one short sentence explaining what they said that implies it. unsupported: empty string.",
          },
        },
        required: ["label", "status", "supportingPassage"],
      },
    },
    recommendationSupported: {
      type: Type.BOOLEAN,
      description: "Is the recommendation's premise honestly supported by the customer's answers?",
    },
    recommendationConcern: {
      type: Type.STRING,
      description: "If not supported: what the customer's answers fail to support. Else empty.",
    },
  },
  required: ["tasks", "recommendationSupported", "recommendationConcern"],
} as const;

export async function verifyGrounding(args: {
  sourceText: string; // everything the customer actually said/typed
  taskLabels: string[];
  recommendationSummary: string;
}): Promise<{
  tasks: Map<string, { status: GroundingStatus; support: string }>;
  recommendationSupported: boolean;
  recommendationConcern: string;
}> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const result = await ai.models.generateContent({
    model: REPORT_MODEL,
    contents: [
      "You are a skeptical verifier. Below is everything a customer said about one workflow, followed by a list of task labels another system extracted, and a recommendation.",
      "For each task, judge honestly:",
      "- grounded: the customer described this activity (in any wording).",
      "- inferred: they did not describe it directly, but what they said clearly implies it.",
      "- unsupported: nothing they said supports it. Be strict — when in doubt between inferred and unsupported, choose unsupported.",
      "Then judge whether the recommendation's premise is supported by their answers.",
      "",
      "CUSTOMER'S ANSWERS:",
      args.sourceText,
      "",
      "EXTRACTED TASKS:",
      ...args.taskLabels.map((t, i) => `${i + 1}. ${t}`),
      "",
      "RECOMMENDATION:",
      args.recommendationSummary,
    ].join("\n"),
    config: { responseMimeType: "application/json", responseSchema: VERIFY_SCHEMA, temperature: 0 },
  });
  const out = JSON.parse(result.text ?? "{}") as {
    tasks: { label: string; status: GroundingStatus; supportingPassage: string }[];
    recommendationSupported: boolean;
    recommendationConcern: string;
  };
  const map = new Map<string, { status: GroundingStatus; support: string }>();
  for (const t of out.tasks ?? []) {
    map.set(normLabel(t.label), { status: t.status, support: t.supportingPassage.trim() });
  }
  return {
    tasks: map,
    recommendationSupported: out.recommendationSupported !== false,
    recommendationConcern: (out.recommendationConcern ?? "").trim(),
  };
}

export function normLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// ---- Fuzzy quote anchoring ----
// Snap a (possibly paraphrased) quote to the closest real span of the source
// text using token-overlap over a sliding window. Returns the actual source
// span when similarity clears the threshold, else null.

const tokenize = (s: string): string[] => normLabel(s).split(" ").filter((w) => w.length > 1);

export function anchorQuote(quote: string, sourceText: string): string | null {
  const qTokens = tokenize(quote);
  if (qTokens.length < 3) return null;
  const qSet = new Set(qTokens);

  // Candidate spans: sentences and clause-ish fragments of the source.
  const spans = sourceText
    .split(/(?<=[.!?;\n])\s+|\s+—\s+/)
    .map((s) => s.trim())
    .filter((s) => tokenize(s).length >= 3);

  let best: { span: string; score: number } | null = null;
  for (const span of spans) {
    const sTokens = tokenize(span);
    const sSet = new Set(sTokens);
    let overlap = 0;
    for (const t of qSet) if (sSet.has(t)) overlap++;
    // Overlap relative to the quote: "is this quote's content in this span?"
    const score = overlap / qSet.size;
    if (!best || score > best.score) best = { span, score };
  }
  if (best && best.score >= 0.6) return best.span;
  return null;
}

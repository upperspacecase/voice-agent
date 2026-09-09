// Weekly re-verification of allowlistTools pricing (runs from the worker).
// For each entry: fetch the live pricing page, have the model extract the
// plans, and compare against what we claim. Match -> sourceDate advances, so
// "verified on" stays honest. Mismatch or unreachable -> needsReview + admin
// email; the report keeps showing the OLD date rather than a fresh lie.

import { GoogleGenAI, Type } from "@google/genai";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { sendAdminNotification } from "./email";
import type { VerifiedTool } from "./tool-allowlist";

const REPORT_MODEL = process.env.REPORT_MODEL ?? "gemini-3-flash-preview";

const EXTRACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    readable: { type: Type.BOOLEAN, description: "Did the page contain a legible pricing table?" },
    plans: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          plan: { type: Type.STRING },
          monthlyUsd: { type: Type.NUMBER },
        },
        required: ["plan", "monthlyUsd"],
      },
    },
  },
  required: ["readable", "plans"],
} as const;

export async function refreshToolPricing(): Promise<void> {
  const db = adminDb();
  const snap = await db.collection("allowlistTools").get();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const today = new Date().toISOString().slice(0, 10);

  for (const doc of snap.docs) {
    const tool = doc.data() as VerifiedTool & { needsReview?: boolean };
    try {
      const res = await fetch(tool.pricingUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HoursPricingCheck/1.0)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, "").slice(0, 120_000);

      const result = await ai.models.generateContent({
        model: REPORT_MODEL,
        contents: [
          `Extract the pricing plans from this page (${tool.pricingUrl}). Monthly USD per seat/user; if only annual billing is shown, convert to per-month.`,
          html,
        ].join("\n\n"),
        config: { responseMimeType: "application/json", responseSchema: EXTRACT_SCHEMA, temperature: 0 },
      });
      const out = JSON.parse(result.text ?? "{}") as {
        readable: boolean;
        plans: { plan: string; monthlyUsd: number }[];
      };
      if (!out.readable) throw new Error("pricing table not readable");

      const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      // Every price we claim must still appear (±10% tolerance for currency
      // rounding) under the same plan name.
      const stillTrue = tool.plans.every((claimed) => {
        const found = out.plans.find((p) => norm(p.plan) === norm(claimed.plan));
        return (
          found != null &&
          Math.abs(found.monthlyUsd - claimed.monthlyUsd) <= claimed.monthlyUsd * 0.1
        );
      });

      if (stillTrue) {
        await doc.ref.update({
          sourceDate: today,
          needsReview: false,
          lastCheckedAt: FieldValue.serverTimestamp(),
        });
        console.log(`[PRICING] ${tool.id} verified, sourceDate -> ${today}`);
      } else {
        await doc.ref.update({
          needsReview: true,
          lastCheckedAt: FieldValue.serverTimestamp(),
          lastCheckFinding: JSON.stringify(out.plans).slice(0, 900),
        });
        console.warn(`[PRICING] ${tool.id} DRIFT — flagged for review`);
        await sendAdminNotification({
          businessName: `PRICING DRIFT: ${tool.name}`,
          assessmentId: `allowlistTools/${tool.id}`,
          shareId: "",
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[PRICING] ${tool.id} check failed: ${msg}`);
      await doc.ref.update({
        needsReview: true,
        lastCheckedAt: FieldValue.serverTimestamp(),
        lastCheckFinding: `check failed: ${msg}`.slice(0, 300),
      });
    }
  }
}

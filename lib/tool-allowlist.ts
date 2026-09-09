// Verified tool store. Entries are created only by a human-verified fetch of
// the live pricing page (see the seeding discipline in the admin runbook) —
// the engine treats these as the only source of price claims. A tool the
// model proposes that isn't here ships with no price and an honest
// "pricing not verified" label.

import { adminDb } from "./firebase-admin";
import type { WorkflowId } from "./taxonomy";

export interface VerifiedTool {
  id: string;
  name: string;
  workflowIds: WorkflowId[];
  url: string;
  pricingUrl: string;
  sourceDate: string; // ISO date the pricing page was verified
  geography: string;
  plans: { plan: string; monthlyUsd: number; note: string }[];
  freeTrial: string | null;
  fit: string;
}

export async function getVerifiedTools(workflowId: WorkflowId): Promise<VerifiedTool[]> {
  const snap = await adminDb()
    .collection("allowlistTools")
    .where("workflowIds", "array-contains", workflowId)
    .get();
  return snap.docs.map((d) => d.data() as VerifiedTool);
}

// Loose name match: "Follow Up Boss" vs "followupboss" vs "Follow-Up Boss".
export function matchVerifiedTool(
  toolName: string | null,
  tools: VerifiedTool[],
): VerifiedTool | null {
  if (!toolName) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(toolName);
  return tools.find((t) => norm(t.name) === target || t.id === target) ?? null;
}

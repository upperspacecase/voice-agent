import { notFound } from "next/navigation";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { Report, type ReportData } from "@/components/Report";
import { FreeReport, type FreeReportData } from "@/components/FreeReport";
import { FullReport, type FullReportData } from "@/components/FullReport";
import { BookingPicker } from "@/components/BookingPicker";
import type {
  FourDayPlanItem,
  Headline,
  PainPoint,
  Recommendation,
  Upsell,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ shareId: string }>;
}

function fmtDate(ts: unknown): string | null {
  if (!ts) return null;
  if (ts instanceof Timestamp) {
    return ts.toDate().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
  return null;
}

function isCompleteReport(raw: Record<string, unknown>): boolean {
  // Treat as renderable only when sub-skill 08 has written the full payload.
  return Boolean(
    raw.headline &&
      typeof raw.executiveSummary === "string" &&
      raw.executiveSummary.length > 0 &&
      Array.isArray(raw.painPoints) &&
      Array.isArray(raw.recommendations) &&
      Array.isArray(raw.fourDayPlan),
  );
}

export default async function PublicReportPage({ params }: PageProps) {
  const { shareId } = await params;

  const snap = await adminDb()
    .collection("publicReports")
    .doc(shareId)
    .get();

  // Hydrate caller info from the assessment doc so the BookingPicker (and the
  // "report being prepared" fallback) always has a name/email to work with.
  let assessmentId = "";
  let clientName = "";
  let clientEmail = "";
  let businessName = "";

  if (snap.exists) {
    const r = snap.data() as Record<string, unknown>;
    assessmentId = (r.assessmentId as string) ?? "";
    clientName = (r.clientName as string) ?? "";
    businessName = (r.businessName as string) ?? "";
  }

  if (!assessmentId) {
    const aSnap = await adminDb()
      .collection("assessments")
      .where("shareId", "==", shareId)
      .limit(1)
      .get();
    if (aSnap.empty && !snap.exists) {
      notFound();
    }
    if (!aSnap.empty) {
      const a = aSnap.docs[0];
      assessmentId = a.id;
      const aData = a.data();
      clientName =
        clientName ||
        (aData.clientName as string | null) ||
        (aData.firstName as string | null) ||
        "";
      businessName = businessName || (aData.businessName as string | null) || "";
      clientEmail = (aData.clientEmail as string | null) ?? "";
    }
  } else if (!clientEmail) {
    try {
      const aSnap = await adminDb().collection("assessments").doc(assessmentId).get();
      if (aSnap.exists) {
        clientEmail = (aSnap.data()?.clientEmail as string | null) ?? "";
      }
    } catch {
      // ignore — picker will still render without the email pre-filled
    }
  }

  const raw = snap.exists ? (snap.data() as Record<string, unknown>) : null;

  // PRD Full Assessment: renders only once approved (FR-43); before that the
  // customer sees the standard "being prepared" state further down.
  if (raw?.kind === "full_v1" && raw.approved === true) {
    return (
      <FullReport
        data={{
          shareId,
          assessmentId,
          clientName: (raw.clientName as string) ?? clientName,
          clientEmail,
          businessName: (raw.businessName as string) ?? businessName,
          executiveSummary: (raw.executiveSummary as string) ?? "",
          workflowMap: (raw.workflowMap as FullReportData["workflowMap"]) ?? [],
          focusWorkflowIds: (raw.focusWorkflowIds as string[]) ?? [],
          recommendations: (raw.recommendations as FullReportData["recommendations"]) ?? [],
          fourDayPlan: (raw.fourDayPlan as FullReportData["fourDayPlan"]) ?? [],
          guaranteeTotalUsd: (raw.guaranteeTotalUsd as number) ?? 0,
          generatedAt: fmtDate(raw.generatedAt),
        }}
      />
    );
  }

  // PRD free assessment: a different, lighter document shape.
  if (raw?.kind === "free_v1") {
    const rec = raw.recommendation as FreeReportData["recommendation"];
    return (
      <FreeReport
        data={{
          shareId,
          clientName: (raw.clientName as string) ?? clientName,
          businessName: (raw.businessName as string) ?? businessName,
          workflowLabel: (raw.workflowLabel as string) ?? "",
          statedOutcome: (raw.statedOutcome as string | null) ?? null,
          currentTimeRange: (raw.currentTimeRange as FreeReportData["currentTimeRange"]) ?? null,
          tasks: (raw.tasks as FreeReportData["tasks"]) ?? [],
          recommendation: rec,
          nextSteps: (raw.nextSteps as string[]) ?? [],
          generatedAt: fmtDate(raw.generatedAt),
        }}
      />
    );
  }

  const ready = raw ? isCompleteReport(raw) : false;

  if (ready && raw) {
    const data: ReportData = {
      shareId,
      clientName: (raw.clientName as string) ?? clientName,
      businessName: (raw.businessName as string) ?? businessName,
      generatedAt: fmtDate(raw.generatedAt),
      headline: raw.headline as Headline,
      executiveSummary: (raw.executiveSummary as string) ?? "",
      painPoints: (raw.painPoints as PainPoint[]) ?? [],
      recommendations: (raw.recommendations as Recommendation[]) ?? [],
      fourDayPlan: (raw.fourDayPlan as FourDayPlanItem[]) ?? [],
      upsells: (raw.upsells as Upsell[]) ?? [],
      bookingUrl: (raw.bookingUrl as string) ?? "",
    };

    return (
      <main className="min-h-screen bg-background text-on-background">
        <Report data={data} />
        <div className="mx-auto w-full max-w-3xl px-[clamp(20px,5vw,48px)] pb-20">
          <BookingPicker
            shareId={shareId}
            assessmentId={assessmentId}
            clientName={clientName}
            clientEmail={clientEmail}
          />
        </div>
      </main>
    );
  }

  // Report not yet written. Show the "preparing" state with the booking
  // picker so the caller can lock in their walkthrough immediately.
  return (
    <main className="relative z-10 mx-auto w-full max-w-3xl px-[clamp(20px,5vw,48px)] pb-20 pt-[clamp(32px,6vw,64px)]">
      <article className="space-y-4">
        <h1
          className="font-display font-black"
          style={{
            fontSize: "clamp(36px, 5vw, 64px)",
            lineHeight: 1.02,
            letterSpacing: "-0.015em",
          }}
        >
          {businessName ? `${businessName}'s Hours report is being prepared` : "Your report is being prepared"}
        </h1>
        <p className="text-[15px] leading-[1.6]" style={{ color: "var(--ink-soft, #5a5448)" }}>
          {clientName ? `Hi ${clientName} — ` : ""}
          we'll email you when it's ready (within 24 hours). In the meantime,
          you can lock in your free walkthrough below.
        </p>
      </article>

      <BookingPicker
        shareId={shareId}
        assessmentId={assessmentId}
        clientName={clientName}
        clientEmail={clientEmail}
      />
    </main>
  );
}

export async function generateMetadata({ params }: PageProps) {
  const { shareId } = await params;
  return {
    title: `Hours assessment · ${shareId}`,
    robots: { index: false, follow: false },
  };
}

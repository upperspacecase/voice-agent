// One-page free assessment (PRD §9.1), editorial layout after River's Sep 9
// mock — with the truth rules enforced in the rendering itself:
//   - every figure is a range from the customer's own answers
//   - tool prices appear only with a verified source date; otherwise the
//     report says so
//   - the workflow grid shows real taxonomy; unexamined rows say "not
//     assessed", and no benchmark comparison renders (none exists yet)

import { WORKFLOWS } from "@/lib/taxonomy";
import type { EngineRecommendation, HoursRange } from "@/lib/assessment-schema";

export interface ReportTask {
  label: string;
  evidenceQuote: string;
  timeRange: HoursRange | null;
  examined: boolean;
}

export interface FreeReportData {
  shareId: string;
  clientName: string;
  businessName: string;
  workflowLabel: string;
  statedOutcome: string | null;
  currentTimeRange: HoursRange | null;
  tasks: ReportTask[];
  recommendation: EngineRecommendation;
  nextSteps: string[];
  generatedAt: string | null;
}

const DISPOSITION_LABEL: Record<EngineRecommendation["disposition"], string> = {
  keep_human: "Keep human",
  automate: "Automate",
  ai: "Use AI",
  hand_off: "Hand off",
  stop: "Stop doing this",
};

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US")}`;

export const FreeReport: React.FC<{ data: FreeReportData }> = ({ data }) => {
  const r = data.recommendation;
  const priceVerified = r.cost.recurringMonthlyUsd != null && r.cost.sourceDate != null;

  return (
    <div className="min-h-screen bg-[#F6F4EF] text-[#0B3049]">
      <main className="mx-auto w-full max-w-[820px] px-5 py-12 md:py-16">
        <header className="mb-10">
          <div className="mb-8 flex items-center justify-between">
            <span className="font-serif text-2xl lowercase">hrs</span>
            <span className="rounded-full bg-[#0B3049]/5 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#476582]">
              Free assessment
            </span>
          </div>
          <h1 className="font-serif text-[clamp(34px,6vw,52px)] leading-[1.05] tracking-[-0.01em]">
            Your Free Time Assessment
          </h1>
          <p className="mt-3 text-[15px] text-[#476582]">
            One workflow. One task. One fix.
            {data.businessName ? ` — for ${data.businessName}` : ""}
            {data.generatedAt ? `, ${data.generatedAt}` : ""}
          </p>
        </header>

        {/* Workflow grid: real taxonomy, honest coverage */}
        <section className="mb-6 rounded-[24px] bg-white p-7 md:p-9">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#476582]">
              Workflow 1 of {WORKFLOWS.length} — 1 task examined
            </span>
            <span className="text-[11px] uppercase tracking-[0.14em] text-[#6B8199]">
              From your answers alone
            </span>
          </div>
          <h2 className="mb-6 font-serif text-[clamp(24px,4vw,34px)] leading-tight">
            {data.workflowLabel}
          </h2>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            <ul className="space-y-2.5">
              {WORKFLOWS.map((w) => {
                const active = w.label === data.workflowLabel;
                return (
                  <li
                    key={w.id}
                    className={
                      active
                        ? "flex items-center justify-between rounded-xl border border-[#C05A3E]/30 bg-[#C05A3E]/5 px-4 py-2.5 text-[14px] font-semibold"
                        : "flex items-center justify-between px-4 py-2.5 text-[14px] text-[#0B3049]/35"
                    }
                  >
                    <span>{w.label}</span>
                    <span className={active ? "text-[11px] font-bold uppercase tracking-widest text-[#C05A3E]" : "text-[11px] uppercase tracking-widest"}>
                      {active ? "Examined" : "Not assessed"}
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-col justify-center">
              <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#476582]">
                Recoverable — estimate
              </div>
              <div className="mt-1 font-serif text-[clamp(40px,7vw,64px)] leading-none text-[#C05A3E]">
                {r.impact.recoverableRange.minHoursPerWeek}–{r.impact.recoverableRange.maxHoursPerWeek}
                <span className="text-[20px]"> hrs/week</span>
              </div>
              <div className="mt-2 text-[15px] text-[#476582]">
                ≈ {fmtUsd(r.impact.annualValueRange.minUsd)}–{fmtUsd(r.impact.annualValueRange.maxUsd)} per year
              </div>
              <div className="mt-4 border-t border-[#0B3049]/8 pt-3 text-[13px] leading-snug text-[#6B8199]">
                Your current time: {data.currentTimeRange
                  ? `${data.currentTimeRange.minHoursPerWeek}–${data.currentTimeRange.maxHoursPerWeek} hrs/week (your estimate)`
                  : "you weren't sure — reflected in the confidence below"}
              </div>
              <div className="mt-1.5 text-[13px] leading-snug text-[#6B8199]">
                Confidence: {r.confidence.level}
              </div>
            </div>
          </div>

          {data.tasks.length > 0 && (
            <div className="mt-8 border-t border-[#0B3049]/8 pt-6">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#476582]">
                Tasks you described in this workflow
              </div>
              <ul className="space-y-2">
                {data.tasks.map((t) => (
                  <li
                    key={t.label}
                    className={
                      t.examined
                        ? "flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-[#C05A3E]/30 bg-[#C05A3E]/5 px-4 py-2.5"
                        : "flex flex-wrap items-baseline justify-between gap-2 px-4 py-2"
                    }
                  >
                    <span className="text-[14px] font-medium">
                      {t.label}
                      {t.examined && (
                        <span className="ml-2 text-[10px] font-bold uppercase tracking-widest text-[#C05A3E]">
                          The fix below
                        </span>
                      )}
                    </span>
                    <span className="text-[12.5px] text-[#6B8199]">
                      {t.timeRange
                        ? `${t.timeRange.minHoursPerWeek}–${t.timeRange.maxHoursPerWeek} hrs/wk (your estimate)`
                        : "time not stated"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 px-4 text-[12px] text-[#6B8199]">
                Drawn from your answers only — a task we couldn&apos;t quote you
                on isn&apos;t listed.
              </p>
            </div>
          )}
        </section>

        {/* Tool shift */}
        <section className="mb-6 rounded-[24px] bg-white p-7 md:p-9">
          <div className="mb-4 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#476582]">
              Your tool shift
            </span>
            <span className="rounded-full bg-[#16a34a]/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[#15803d]">
              {DISPOSITION_LABEL[r.disposition]}
            </span>
          </div>
          <p className="mb-2 text-[14px] leading-snug text-[#6B8199]">{r.currentState}</p>
          <p className="text-[16px] leading-[1.7]">{r.recommendation}</p>

          {r.toolOrApproach && (
            <div className="mt-5 rounded-2xl border border-[#16a34a]/40 bg-[#16a34a]/5 px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[15px] font-bold">{r.toolOrApproach}</span>
                {priceVerified ? (
                  <span className="text-[14px] font-semibold text-[#0B3049]">
                    from {fmtUsd(r.cost.recurringMonthlyUsd!)}/mo
                  </span>
                ) : (
                  <span className="text-[13px] text-[#6B8199]">
                    pricing not verified — check the vendor&apos;s site
                  </span>
                )}
              </div>
              {priceVerified && r.evidence.externalSources[0] && (
                <div className="mt-1 text-[12px] text-[#6B8199]">
                  Pricing checked against{" "}
                  <a
                    href={r.evidence.externalSources[0].url}
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    the vendor&apos;s pricing page
                  </a>{" "}
                  on {r.cost.sourceDate}.
                </div>
              )}
            </div>
          )}

          {r.evidence.customerQuotes.length > 0 && (
            <div className="mt-5 border-t border-[#0B3049]/8 pt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6B8199]">
                Why this, in your words
              </div>
              <div className="flex flex-wrap gap-2">
                {r.evidence.customerQuotes.map((q) => (
                  <span
                    key={q}
                    className="rounded-full bg-[#F6F4EF] px-3.5 py-1.5 text-[13px] italic text-[#0B3049]/75"
                  >
                    &ldquo;{q}&rdquo;
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Next steps */}
        <section className="mb-6 rounded-[24px] bg-white p-7 md:p-9">
          <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#476582]">
            Your next steps — this week
          </div>
          <ol className="space-y-3">
            {[...r.setupSteps, ...data.nextSteps]
              .filter((s, i, arr) => arr.indexOf(s) === i)
              .slice(0, 5)
              .map((s, i) => (
                <li key={s} className="flex items-start gap-3 text-[14.5px] leading-[1.55]">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#16a34a] text-[12px] font-bold text-white">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">{s}</span>
                </li>
              ))}
          </ol>
          {r.agentPrompt && (
            <details className="mt-5 border-t border-[#0B3049]/8 pt-4">
              <summary className="cursor-pointer text-[13px] font-semibold text-[#16a34a]">
                Agent-ready prompt — paste into the AI tool you use
              </summary>
              <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-[#F6F4EF] p-4 text-[12.5px] leading-[1.6]">
                {r.agentPrompt}
              </pre>
            </details>
          )}
        </section>

        <p className="mb-10 text-[12px] leading-[1.7] text-[#6B8199]">
          How these numbers were made: your stated time, reduced to what the
          change can defensibly recover, at {r.assumptions.workingWeeksPerYear}{" "}
          working weeks/year and {fmtUsd(r.assumptions.loadedHourlyCostUsd)}/hr
          loaded cost{priceVerified ? ", minus the tool cost above" : ""}. No
          industry benchmark was applied — none we can source yet, so we
          don&apos;t pretend. Confidence: {r.confidence.level} (
          {r.confidence.reason}).{" "}
          <a
            href={`/api/reports/${data.shareId}/markdown`}
            className="font-semibold text-[#16a34a] underline"
          >
            Download as Markdown
          </a>
        </p>

        <section className="rounded-[24px] bg-white p-8 text-center md:p-10">
          <p className="mb-1 font-serif text-[19px]">
            This was 1 task in 1 of {WORKFLOWS.length} workflows.
          </p>
          <p className="mx-auto mb-5 max-w-[460px] text-[14px] leading-[1.6] text-[#476582]">
            The Full Assessment maps all six and selects up to three priority
            changes — guaranteed to identify $10,000+ in recoverable time, or
            it&apos;s free and you keep the report.
          </p>
          <a
            href={`/api/full/upgrade?shareId=${data.shareId}`}
            className="inline-block rounded-full bg-[#16a34a] px-8 py-3.5 text-[14px] font-semibold text-white transition-colors hover:bg-[#15803d]"
          >
            Book the Full Assessment — $497
          </a>
        </section>
      </main>
    </div>
  );
};

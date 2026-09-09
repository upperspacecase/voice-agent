import { HeroCallForm } from "./site/HeroCallForm";
import { PROMISES } from "@/lib/promises";

export const HomeHero: React.FC = () => {
  return (
    <section className="relative overflow-hidden pb-[64px] pt-[64px] md:pb-[96px] md:pt-[104px]">
      <div className="relative z-10 mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-12 px-5 md:grid-cols-12 md:gap-10 md:px-8">
        <div className="md:col-span-6 lg:col-span-7 lg:pr-8">
          <p className="mb-4 text-[13px] font-semibold uppercase tracking-widest text-[#16a34a]">
            For real-estate teams
          </p>
          <h1 className="mb-5 text-[clamp(36px,5.5vw,64px)] font-bold leading-[1.05] tracking-[-0.03em] text-[#0B3049] md:mb-6">
            Find the workflow costing your team the most hours.
          </h1>

          <p className="mb-7 max-w-xl text-base leading-[1.6] text-[#476582] md:mb-8 md:text-lg">
            Lead follow-up, paperwork chasing, duplicated entry, coordination
            that never ends — your team knows it&apos;s busy, not which workflow
            deserves attention first. A free phone assessment finds it, prices
            it, and gives you one clear change to make.
          </p>

          <p className="flex items-start gap-2 text-sm leading-[1.6] text-[#6B8199]">
            <span aria-hidden className="material-symbols-outlined mt-0.5 text-[16px]">
              schedule
            </span>
            One workflow. One task. One fix. Free, with a one-page report{" "}
            {PROMISES.freeSlaLabel} — and a $497 Full Assessment when you want
            the whole operation mapped.
          </p>
        </div>

        <div id="call" className="md:col-span-6 lg:col-span-5">
          <HeroCallForm />
        </div>
      </div>
    </section>
  );
};

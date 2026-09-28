# Weekly industry research candidates — 2026-09-28

**Status: nothing in this file has been human-verified.** Every claim below is a
candidate for a human to check before it is ever used anywhere customer-facing.

## Blocker this run

This session's `WebFetch` tool was denied outbound access by the environment's
network egress policy for every host attempted this run, including a neutral
control host (`https://example.com`) used to confirm the block was not
domain-specific. Only `WebSearch` (a separate, AI-summarized search mechanism)
was reachable. Because `WebSearch` returns paraphrased summaries rather than a
page Claude opened and read itself, and this pipeline's rule is "skip anything
you cannot open and read yourself," no claim below is being asserted as
sourced — see each section.

To unblock future runs: broaden this environment's network access level, or
add the specific vendor/publisher domains below to its allowed-domains list,
in the cloud environment's settings (title bar → environment menu → Edit →
Network access).

## 1. Time-use references

Nothing verifiable found this week — `WebFetch` could not open any candidate
source (NAR newsroom, HousingWire, vendor blogs) to confirm figures firsthand,
so no metric/figure/geography/date/URL row can be certified as read rather
than guessed at.

Unverified leads surfaced by `WebSearch` only (NOT opened, NOT confirmed —
do not use until fetched and read directly):
- NAR newsroom report on REALTOR® technology adoption and time savings,
  referenced at `nar.realtor/newsroom` (exact URL and figures unconfirmed).
- HousingWire coverage of NAR's 2026 tech report (`housingwire.com`, exact
  URL and figures unconfirmed).
- A claim of "over 15 hours" median real-estate lead response time,
  attributed secondhand to "Inman's 2025 Real Estate Technology Survey" by a
  vendor blog — the primary Inman source was not located or opened.

## 2. Tool pricing drift

`docs/research/allowlist.md` does not exist in this repo, so the fallback
targets applied: Follow Up Boss (`followupboss.com/pricing`) and Pipedrive
(`pipedrive.com/en/pricing`). Both were blocked by the network egress policy
on every attempt (with and without `www.`):

- `https://www.followupboss.com/pricing` — EGRESS_BLOCKED
- `https://followupboss.com/pricing` — EGRESS_BLOCKED
- `https://www.pipedrive.com/en/pricing` — EGRESS_BLOCKED
- `https://pipedrive.com/en/pricing` — EGRESS_BLOCKED

Nothing verifiable found this week.

## 3. Landscape

Nothing verifiable found this week — the same `WebFetch` block applied to
every candidate landscape article, so no launch/change/shutdown claim could
be confirmed by directly reading the source.

Unverified leads surfaced by `WebSearch` only (NOT opened, NOT confirmed):
- A claim that LionDesk (a real-estate CRM) was wound down around
  September 2025, with users pointed to Lone Wolf Relationships.
- A claim that Lofty launched an "agentic AI operating system" for real
  estate in February 2026.
- A claim about expanded Zillow/Follow Up Boss integration ("Zillow Pro")
  in mid-2026.

## Verification checklist

- [ ] Confirm the environment network policy blocking `WebFetch` and get it
      broadened or allowlisted for `nar.realtor`, `housingwire.com`,
      `followupboss.com`, `pipedrive.com`, and other industry-source domains.
- [ ] Re-run this week's three passes once `WebFetch` is unblocked.
- [ ] Open and read the NAR newsroom technology-adoption report directly;
      extract exact time-use/time-saved figures with URL and date.
- [ ] Locate and open Inman's 2025 Real Estate Technology Survey (primary
      source, not a vendor's secondhand citation) for the lead-response-time
      figure.
- [ ] Open `followupboss.com/pricing` directly and record current plan names
      and monthly USD prices as shown.
- [ ] Open `pipedrive.com/en/pricing` directly and record current plan names
      and monthly USD prices as shown.
- [ ] Open and read the LionDesk shutdown / Lone Wolf Relationships coverage
      directly; confirm date and URL.
- [ ] Open and read the Lofty "agentic AI operating system" launch coverage
      directly; confirm date and URL.
- [ ] Open and read the Zillow Pro / Follow Up Boss integration coverage
      directly; confirm date and URL.

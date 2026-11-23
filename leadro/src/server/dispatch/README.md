# dispatch

Dispatch engine (§7.3-7.5, §25.2, §28.6): hard eligibility filter, explainable rule-based recommendations, the dispatcher's
approve / modify / reject with recorded overrides, and dispatch modes. Routes `/api/v1/dispatch/**`
(`docs/API_REFERENCE.md` "Dispatch"). Pure ranking and haversine: `src/lib/dispatch-scoring.ts`. Design: `DECISIONS.md` "Phase 2 Task 7".

Public API (`index.ts`):
- Mode: `getDispatchSettings`, `updateDispatchSettings`, `loadDispatchMode`. MANUAL and AI_ASSISTED run; RULE_BASED_AUTO and
  OPTIMIZATION are refused as "not available in this phase".
- Recommendations: `generateRecommendation` (persists a `DispatchRecommendation`, supersedes pending ones), `getRecommendation`,
  `listRecommendations`, `getEligibilityOverview` (eligible ids + blocking reasons, nothing stored).
- Decisions: `approveRecommendation`, `modifyRecommendation`, `rejectRecommendation`.

Invariants:
- Ranking sees only employees who passed the qualification engine's hard rules; no performance data anywhere. Soft factors are
  distance (straight-line estimate), open workload, completed jobs of the job type, customer preferred/avoid.
- Deterministic and explainable: every factor stores key, value, contribution and an i18n key; conflicts are warnings.
- JSON columns hold ids and codes only (no names, addresses, phones). Clients resolve ids through other modules' tenant-checked APIs.
- Generating never assigns. Accepting calls jobs' `assignJob` (hard eligibility and `jobs.approve` for overrides re-checked at
  decision time) and then stamps `recommendationId` / method through `linkAssignmentToRecommendation`.
- Every decision records who, when, why and whom, in the row and in the audit log.
- Every function checks its permission over the job (`dispatch.create` / `view` / `assign`); out-of-scope jobs are 404.

Files: `picture.ts` (eligibility + soft-factor inputs), `recommend.ts`, `decide.ts`, `settings.ts`, `views.ts`, `schemas.ts`.

import { assessmentOf, MIN_PEERS_FOR_POSITION, positionAmong, type Assessment, type MetricPosition } from "@/lib/metric-position";
import { can, canViewFields } from "@/server/authz";
import { listContextNotes, listCoachingRecords, type CoachingRecordView, type ContextNoteView } from "@/server/coaching";
import type { Actor } from "@/server/core";
import { getPlan, listPlans, listRecommendations, type PlanSummaryView, type RecommendationView, type ReviewView } from "@/server/development";
import { listEmployeeCurrentValues, listPeerCurrentValues, type PeerSeries } from "@/server/performance";

/**
 * The manager development dashboard of one employee (spec 10.4; `GET /api/v1/employees/{id}/development`). A READ MODEL
 * composed from the public read functions of the performance, coaching and development modules; it writes nothing and
 * nothing that decides work, pay or employment imports it (spec 10.3, `tests/development-dashboard/architecture.test.ts`).
 *
 * - Access: `performance.view` over the employee (403 without it, 404 outside the scope), through the performance module.
 * - Metrics: values of PUBLISHED (current or retired) definition versions only; one entry per series (definition version
 *   + job type / category) with its history over periods, the latest period's position among the colleagues in the
 *   VIEWER's scope with comparable values (same version, period and breakdown), and evidence links. There is never a
 *   number that combines dimensions or employees.
 * - Coaching content (coaching notes, context notes, plans and their review history) needs the `coaching` field set
 *   (`performance.coaching_fields`, Task 1 contract) AND the owning module's permission; otherwise the section is `null`
 *   ("not visible to you"), never an error.
 * - Training recommendations need `training.view` over the employee (the development module's own check).
 */

/** Sections are bounded so the dashboard stays one cheap call; each owning module's list endpoint pages through the rest. */
const NOTES_LIMIT = 50;
const PLANS_LIMIT = 10;
const RECOMMENDATIONS_LIMIT = 50;

/** The fields of a value the performance read model returns (`listEmployeeCurrentValues`). */
interface ValueEntry {
  id: string;
  definitionId: string;
  periodStart: string;
  periodEnd: string;
  jobTypeId: string | null;
  jobCategory: string | null;
  numerator: number;
  denominator: number;
  sampleSize: number;
  enoughData: boolean;
  evidenceCount: number;
  computedAt: Date | string;
  key: string;
  version: number;
  kind: string;
  dimension: string;
  definitionStatus: string;
  minSample: number;
  evidenceTable: string;
  numeratorKind: string;
}

/** One period of a series, with the link to its evidence (`GET /api/v1/performance/values/{id}` lists the evidence ids). */
function periodView(value: ValueEntry) {
  return {
    valueId: value.id,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    numerator: value.numerator,
    denominator: value.denominator,
    sampleSize: value.sampleSize,
    enoughData: value.enoughData,
    evidenceCount: value.evidenceCount,
    computedAt: value.computedAt,
    evidenceUrl: `/api/v1/performance/values/${value.id}`,
  };
}
export type DevelopmentPeriodView = ReturnType<typeof periodView>;

export interface DevelopmentMetricView {
  definitionId: string;
  key: string;
  version: number;
  kind: string;
  dimension: string;
  definitionStatus: string;
  minSample: number;
  numeratorKind: string;
  evidenceTable: string;
  jobTypeId: string | null;
  jobCategory: string | null;
  /** The latest period of the series. */
  current: DevelopmentPeriodView;
  /** Position of `current` among comparable colleagues in the viewer's scope (never a score). */
  position: MetricPosition;
  assessment: Assessment | null;
  /** Every period of the series, oldest first ("historical improvement"). */
  history: DevelopmentPeriodView[];
}

export interface DevelopmentSeriesRef {
  definitionId: string;
  key: string;
  dimension: string;
  jobTypeId: string | null;
  jobCategory: string | null;
  valueId: string;
}

export interface EmployeeDevelopmentView {
  employeeId: string;
  generatedAt: string;
  minPeersForPosition: number;
  metrics: DevelopmentMetricView[];
  strengths: DevelopmentSeriesRef[];
  developmentOpportunities: DevelopmentSeriesRef[];
  /** OPEN recommendations; null = the viewer holds no `training.view` over the employee. */
  recommendations: RecommendationView[] | null;
  /** Null = not visible to the viewer (no `coaching` field set, or no `coaching.view`). */
  coachingNotes: CoachingRecordView[] | null;
  /** Null = not visible to the viewer (no `coaching` field set). */
  contextNotes: ContextNoteView[] | null;
  /** Null = not visible to the viewer (no `coaching` field set, or no `development_plans.view`). */
  plans: PlanSummaryView[] | null;
  /** Review entries of those plans, newest first; null when `plans` is. */
  reviewHistory: Array<ReviewView & { planId: string }> | null;
}

const seriesKey = (value: Pick<ValueEntry, "definitionId" | "jobTypeId" | "jobCategory">) => JSON.stringify([value.definitionId, value.jobTypeId, value.jobCategory]);

/** Groups current values into series (definition version + breakdown), each with its periods oldest first. */
function groupSeries(values: ValueEntry[]): ValueEntry[][] {
  const groups = new Map<string, ValueEntry[]>();
  for (const value of values) {
    const list = groups.get(seriesKey(value)) ?? [];
    list.push(value);
    groups.set(seriesKey(value), list);
  }
  return [...groups.values()].map((list) => list.sort((a, b) => a.periodStart.localeCompare(b.periodStart)));
}

async function metricsOf(actor: Actor, employeeId: string): Promise<DevelopmentMetricView[]> {
  const values = (await listEmployeeCurrentValues(actor, employeeId, { enoughDataOnly: false }, { publishedOnly: true })) as unknown as ValueEntry[];
  const series = groupSeries(values);
  const latest = series.map((periods) => periods[periods.length - 1] as ValueEntry);
  const groups: PeerSeries[] = latest.map((value) => ({
    definitionId: value.definitionId,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    jobTypeId: value.jobTypeId,
    jobCategory: value.jobCategory,
  }));
  const peers = await listPeerCurrentValues(actor, groups);
  return series.map((periods, index) => {
    const current = latest[index] as ValueEntry;
    const position = positionAmong({ employeeId, numerator: current.numerator, denominator: current.denominator, enoughData: current.enoughData }, peers[index] ?? [], current.kind);
    return {
      definitionId: current.definitionId,
      key: current.key,
      version: current.version,
      kind: current.kind,
      dimension: current.dimension,
      definitionStatus: current.definitionStatus,
      minSample: current.minSample,
      numeratorKind: current.numeratorKind,
      evidenceTable: current.evidenceTable,
      jobTypeId: current.jobTypeId,
      jobCategory: current.jobCategory,
      current: periodView(current),
      position,
      assessment: assessmentOf(position),
      history: periods.map(periodView),
    };
  });
}

const refOf = (metric: DevelopmentMetricView): DevelopmentSeriesRef => ({
  definitionId: metric.definitionId,
  key: metric.key,
  dimension: metric.dimension,
  jobTypeId: metric.jobTypeId,
  jobCategory: metric.jobCategory,
  valueId: metric.current.valueId,
});

/** Plans (newest first) and the review entries of those plans (newest first). */
async function plansOf(actor: Actor, employeeId: string): Promise<{ plans: PlanSummaryView[]; reviewHistory: Array<ReviewView & { planId: string }> }> {
  const plans = (await listPlans(actor, { employeeId, limit: PLANS_LIMIT })).data;
  const details = await Promise.all(plans.map((plan) => getPlan(actor, plan.id)));
  const reviewHistory = details
    .flatMap((plan) => plan.reviews.map((review) => ({ ...review, planId: plan.id })))
    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || b.id.localeCompare(a.id));
  return { plans, reviewHistory };
}

/**
 * `GET /employees/{id}/development`: the dashboard of one employee in the caller's `performance.view` scope.
 * @throws ForbiddenError (no `performance.view`), NotFoundError (employee outside the scope)
 */
export async function getEmployeeDevelopment(actor: Actor, employeeId: string): Promise<EmployeeDevelopmentView> {
  // First, because it enforces `performance.view` over the employee: nothing else is read for someone outside the scope.
  const metrics = await metricsOf(actor, employeeId);
  const resource = { employeeId };
  const [coachingSet, coachingView, plansView, trainingView] = await Promise.all([
    canViewFields(actor, "performance.coaching_fields", resource),
    can(actor, "coaching.view", resource),
    can(actor, "development_plans.view", resource),
    can(actor, "training.view", resource),
  ]);
  const coaching = coachingSet.allowed;
  const [recommendations, coachingNotes, contextNotes, planSection] = await Promise.all([
    trainingView.allowed ? listRecommendations(actor, { employeeId, status: "OPEN", limit: RECOMMENDATIONS_LIMIT }).then((page) => page.data) : null,
    coaching && coachingView.allowed ? listCoachingRecords(actor, { employeeId, limit: NOTES_LIMIT }).then((page) => page.data) : null,
    coaching ? listContextNotes(actor, { employeeId, limit: NOTES_LIMIT }).then((page) => page.data) : null,
    coaching && plansView.allowed ? plansOf(actor, employeeId) : null,
  ]);
  return {
    employeeId,
    generatedAt: new Date().toISOString(),
    minPeersForPosition: MIN_PEERS_FOR_POSITION,
    metrics,
    strengths: metrics.filter((metric) => metric.assessment === "STRENGTH").map(refOf),
    developmentOpportunities: metrics.filter((metric) => metric.assessment === "DEVELOPMENT_OPPORTUNITY").map(refOf),
    recommendations,
    coachingNotes,
    contextNotes,
    plans: planSection?.plans ?? null,
    reviewHistory: planSection?.reviewHistory ?? null,
  };
}

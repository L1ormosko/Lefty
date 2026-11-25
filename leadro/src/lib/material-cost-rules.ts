/**
 * Pure rules of material costing (spec 11.4, 25.4). No database, no framework.
 *
 * The one piece of arithmetic in the materials module lives here: the extended cost of a usage line is
 *
 *     extendedCostMinor = quantity x unitCostMinor, rounded to whole minor units, HALF-EVEN
 *
 * `quantity` is a `Decimal(12,3)` (at most three decimals), `unitCostMinor` a whole number of minor units. The product is
 * computed exactly in thousandths of a minor unit (`bigint`), then rounded once. Half-even ("banker's rounding"): an exact
 * half goes to the even neighbour (637.5 -> 638, 636.5 -> 636), anything else to the nearest whole unit. This is plain
 * multiplication, not a pricing formula; the rounding rule is recorded in docs/DECISIONS.md "Phase 4 Task 2" for the
 * owner's review.
 */

/** Thousandths per unit of quantity (`Decimal(12,3)`). */
const QUANTITY_SCALE = 1000n;

const QUANTITY_TEXT = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,3}))?$/;

/**
 * Converts a non-negative quantity with at most three decimals (as text, e.g. `Prisma.Decimal#toFixed(3)` or `"2.5"`) to
 * an exact count of thousandths (`"2.5"` -> `2500n`).
 * @throws Error for anything else (negative, more than three decimals, exponent forms): a programming error, because
 *   the column cannot hold such a value.
 */
export function quantityToThousandths(quantity: string): bigint {
  const match = QUANTITY_TEXT.exec(quantity.trim());
  if (!match) throw new Error(`Not a Decimal(12,3) quantity: ${quantity}`);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(3, "0"));
  return whole * QUANTITY_SCALE + fraction;
}

/** Divides a non-negative `numerator` by a positive `divisor`, rounding half to even. */
function divideHalfEven(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor;
  const twiceRemainder = (numerator % divisor) * 2n;
  if (twiceRemainder > divisor) return quotient + 1n;
  if (twiceRemainder < divisor) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n; // exactly half: to the even neighbour
}

/**
 * The extended cost of `quantityThousandths / 1000` units at `unitCostMinor` per unit, in whole minor units (half-even).
 * @throws Error for negative inputs (quantities and costs are non-negative by CHECK constraint).
 */
export function extendedCostMinor(quantityThousandths: bigint, unitCostMinor: bigint): bigint {
  if (quantityThousandths < 0n || unitCostMinor < 0n) throw new Error("quantity and unit cost must be non-negative");
  return divideHalfEven(quantityThousandths * unitCostMinor, QUANTITY_SCALE);
}

/** Units are compared trimmed and case-insensitively ("Each" = "each"); there is no unit conversion. */
export function unitsMatch(usageUnit: string, materialUnit: string): boolean {
  return usageUnit.trim().toLowerCase() === materialUnit.trim().toLowerCase();
}

/** A free-text `materialRef` from the field app, read as a catalog code (codes are lower-case). */
export function materialCodeFromRef(materialRef: string | null): string | null {
  if (materialRef === null) return null;
  const code = materialRef.trim().toLowerCase();
  return code.length > 0 ? code : null;
}

export interface EffectivePeriod {
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** Is `at` inside `[effectiveFrom, effectiveTo)` (open-ended when `effectiveTo` is null)? Same rule as the GiST range. */
export function isEffectiveAt(period: EffectivePeriod, at: Date): boolean {
  const time = at.getTime();
  return period.effectiveFrom.getTime() <= time && (period.effectiveTo === null || time < period.effectiveTo.getTime());
}

/**
 * Why a new cost version starting at `effectiveFrom` cannot follow the latest approved version, or null when it can.
 * - `not_after_current`: it must start strictly after the current version's start (the current version is closed at
 *   `effectiveFrom`, and a period cannot be empty);
 * - `costed_usage_after`: a usage already costed with the current version happened at or after `effectiveFrom`. Approving
 *   would leave that frozen snapshot outside its version's period, so the change must start later (corrections of past
 *   jobs are adjustments, never rewrites).
 */
export function newVersionPlacementProblem(input: {
  effectiveFrom: Date;
  current: EffectivePeriod | null;
  latestCostedUsageAt: Date | null;
}): "not_after_current" | "costed_usage_after" | null {
  const { effectiveFrom, current, latestCostedUsageAt } = input;
  if (current) {
    if (effectiveFrom.getTime() <= current.effectiveFrom.getTime()) return "not_after_current";
    if (current.effectiveTo !== null && effectiveFrom.getTime() < current.effectiveTo.getTime()) return "not_after_current";
  }
  if (latestCostedUsageAt && latestCostedUsageAt.getTime() >= effectiveFrom.getTime()) return "costed_usage_after";
  return null;
}

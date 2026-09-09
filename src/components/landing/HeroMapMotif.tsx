import { AvailabilityBadge, VerificationBadge } from "@/components/badges";
import { Card } from "@/components/ui";

/**
 * Hero visual: a stylised outline of Israel with plotted points, echoing the
 * real map, plus two cards showing the real status badges the product uses.
 *
 * Deliberately not a photograph and not a screenshot. We have no rights-cleared
 * billboard photography, and a mocked-up listing would put invented cities and
 * invented prices on the front page - exactly what DECISIONS.md forbids. The
 * cards carry the real badge components over neutral placeholder bars: they
 * show what the interface looks like without asserting that any particular
 * space exists at any particular price.
 */
/**
 * The outline, projected from real coordinates rather than drawn by eye. The
 * first version was sixteen arbitrary points and looked nothing like the
 * country - no Negev wedge, no point at Eilat. Israel is roughly 155km wide
 * and 426km tall, so the shape is deliberately narrow inside the 200x320 box
 * instead of stretched to fill it.
 */
const ISRAEL_OUTLINE =
  "M130 24 L150 44 L143 65 L130 81 L129 101 L130 122 L125 131 L122 158 L119 180 " +
  "L107 216 L98 251 L90 295 L67 230 L59 196 L53 180 L49 171 L67 139 L81 110 " +
  "L86 92 L94 56 L99 49 L101 37 Z";

/** Real cities, at their real positions. Be'er Sheva is the pilot market. */
const PINS = [
  { cx: 94, cy: 57, r: 4 },
  { cx: 82, cy: 110, r: 4 },
  { cx: 108, cy: 131, r: 4 },
  { cx: 82, cy: 169, r: 6 },
  { cx: 92, cy: 216, r: 3.5 },
];

export function HeroMapMotif() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="relative rounded-lg border border-ink-200 bg-ink-50 overflow-hidden aspect-square sm:aspect-[4/5] lg:aspect-square">
        {/* Faint grid, the same visual register as a map canvas */}
        <svg className="absolute inset-0 size-full" viewBox="0 0 200 320" preserveAspectRatio="xMidYMid slice">
          <defs>
            <pattern id="velto-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M20 0 H0 V20" fill="none" stroke="#d5dae2" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="200" height="320" fill="url(#velto-grid)" />

          {/* A motif, not a survey-grade map - but recognisably the country. */}
          <path
            d={ISRAEL_OUTLINE}
            fill="#ffffff"
            stroke="#b1bac8"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />

          {PINS.map((pin) => (
            <g key={`${pin.cx}-${pin.cy}`}>
              <circle cx={pin.cx} cy={pin.cy} r={pin.r * 2.6} fill="#3563f0" opacity="0.12" />
              <circle cx={pin.cx} cy={pin.cy} r={pin.r} fill="#1f45d6" stroke="#ffffff" strokeWidth="1.5" />
            </g>
          ))}
        </svg>
      </div>

      {/* The real status badges over neutral bars - the interface, not a listing */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:mt-0 sm:block">
        <Card className="p-3 sm:absolute sm:-bottom-6 sm:-start-6 sm:w-52 sm:rotate-[-2deg] sm:shadow-panel">
          <div className="h-14 rounded bg-ink-100 mb-2.5" />
          <div className="h-2 w-24 rounded-full bg-ink-200" />
          <div className="mt-1.5 h-2 w-16 rounded-full bg-ink-100" />
          <div className="mt-2.5 flex flex-wrap gap-1">
            <AvailabilityBadge state="AVAILABLE" size="sm" />
            <VerificationBadge status="VERIFIED" size="sm" />
          </div>
        </Card>

        <Card className="p-3 sm:absolute sm:-bottom-2 sm:start-40 sm:w-48 sm:rotate-[1.5deg] sm:shadow-panel">
          <div className="h-14 rounded bg-ink-100 mb-2.5" />
          <div className="h-2 w-20 rounded-full bg-ink-200" />
          <div className="mt-1.5 h-2 w-14 rounded-full bg-ink-100" />
          <div className="mt-2.5 flex flex-wrap gap-1">
            <AvailabilityBadge state="PARTIAL" size="sm" />
          </div>
        </Card>
      </div>
    </div>
  );
}

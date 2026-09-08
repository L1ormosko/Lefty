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
const PINS = [
  { cx: 96, cy: 62, r: 5 },
  { cx: 108, cy: 104, r: 4 },
  { cx: 84, cy: 150, r: 4 },
  { cx: 120, cy: 196, r: 5 },
  { cx: 92, cy: 244, r: 4 },
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

          {/* Simplified silhouette - a motif, not a survey-grade map */}
          <path
            d="M104 14 L128 26 L134 58 L124 92 L136 122 L128 158 L138 186 L120 214 L112 252 L96 300 L86 262 L74 214 L70 170 L78 128 L72 92 L84 52 Z"
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

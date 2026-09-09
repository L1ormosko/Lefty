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
 *
 * The outline is projected from Natural Earth 1:10m boundary data
 * rather than drawn by hand.
 *
 * Two earlier versions were placed by eye and both were wrong - the first had
 * no Negev wedge and no point at Eilat, the second still read as crooked. The
 * lesson is in the method, not the coordinates: a recognisable coastline is
 * not something to approximate from memory.
 *
 * Israel and the Palestinian territories are merged into a single landmass.
 * A decorative motif on a marketing page has no business drawing internal
 * boundaries, and a notch cut out of the middle reads as a rendering fault.
 *
 * Projected equirectangular with a cos(lat) correction, so the 2.7:1 height to
 * width ratio is true; stretching it to fill the box is what made the first
 * attempt a blob. Simplified with Douglas-Peucker to 81 points.
 */
const ISRAEL_OUTLINE =
  "M44.8 170.3 L54.5 160.8 L63.0 150.1 L71.6 135.7 L78.3 121.4 L86.5 96.2 L93.3 62.3 " +
  "L93.7 55.4 L95.2 53.3 L98.9 54.4 L101.2 52.0 L103.6 34.4 L115.7 33.4 L119.7 36.9 " +
  "L128.4 34.4 L133.0 19.6 L136.5 22.5 L142.8 16.4 L147.4 14.9 L150.8 10.0 L150.1 13.6 " +
  "L147.4 15.5 L149.5 17.2 L147.4 20.3 L149.7 22.1 L149.9 25.6 L151.4 26.6 L150.2 32.4 " +
  "L152.6 33.6 L153.3 41.9 L155.2 45.4 L152.7 49.1 L151.7 54.3 L146.6 60.7 L138.7 65.7 " +
  "L137.1 65.6 L133.8 68.7 L135.0 74.8 L133.8 77.8 L135.0 80.1 L133.8 81.2 L134.5 82.8 " +
  "L132.9 86.6 L134.1 89.6 L134.5 99.5 L132.1 109.3 L132.8 111.1 L131.3 113.4 L132.8 122.0 " +
  "L131.4 124.0 L133.7 135.7 L128.5 145.2 L126.7 163.6 L123.0 174.6 L125.6 182.1 L125.8 186.4 " +
  "L122.7 192.5 L122.3 197.2 L118.2 202.7 L117.8 207.9 L115.4 211.1 L110.5 223.7 L106.3 238.0 " +
  "L107.7 243.3 L105.3 252.2 L106.6 261.5 L102.7 268.4 L96.4 297.6 L93.9 305.7 L91.3 310.0 " +
  "L89.7 310.0 L87.7 305.7 L85.6 290.7 L80.2 275.5 L79.7 270.0 L70.9 244.6 L66.2 239.6 " +
  "L66.8 234.1 L64.7 230.3 L63.1 221.0 L44.8 170.3 Z ";

/** Real cities at their real positions. Be'er Sheva is the pilot market. */
const PINS = [
  { cx: 99.5, cy: 56.5, r: 4 },
  { cx: 86.0, cy: 113.0, r: 4.5 },
  { cx: 110.8, cy: 134.6, r: 4 },
  { cx: 83.4, cy: 175.2, r: 6.5 },
  { cx: 94.0, cy: 295.0, r: 3 },
];

export function HeroMapMotif() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="relative rounded-lg border border-ink-200 bg-ink-50 overflow-hidden aspect-[3/4] sm:aspect-[4/5] lg:aspect-[3/4]">
        {/* Faint grid, the same visual register as a map canvas. Painted by the
            container rather than inside the outline's SVG: the outline has to
            scale to fit (a 2.7:1 shape cropped to fill a square loses the
            Galilee and Eilat), while the grid has to cover the whole panel.
            One viewBox cannot do both. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, #dde2ea 1px, transparent 1px)," +
              "linear-gradient(to bottom, #dde2ea 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <svg
          className="absolute inset-0 size-full"
          /* 375 rather than 320: the extra 55 units are empty space at the
             bottom, so the point at Eilat clears the cards that overlap the
             panel there instead of being hidden behind them. */
          viewBox="0 0 200 375"
          preserveAspectRatio="xMidYMid meet"
        >
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

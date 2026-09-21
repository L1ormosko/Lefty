/**
 * Angles and distances between two points on the earth.
 *
 * Here because of a bug with a very visible symptom: the listing page embedded
 * Street View with nothing but the sign's coordinates, so Google snapped to
 * whichever panorama was nearest and pointed the camera in whatever direction
 * that panorama happened to face. On a corner plot that is a different street
 * entirely - the page claimed to show the site and showed somewhere else.
 *
 * The fix needs two numbers the embed was never given: which panorama, and
 * which way to look from it. The second one is this file.
 */

export type LatLng = { lat: number; lng: number };

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * The compass bearing from one point to another, in degrees clockwise from
 * north - which is exactly what Street View's `heading` parameter wants.
 *
 * Spherical rather than planar. At Israel's latitude a degree of longitude is
 * about 0.83 of a degree of latitude, so treating the two as interchangeable
 * puts a sign across the street off by several degrees - enough to frame the
 * building next door instead.
 */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lng - from.lng);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  // atan2 gives -180..180; Street View wants 0..360, and 360 is 0.
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Metres between two points, by the haversine formula.
 *
 * Used to decide whether the panorama Google offered is close enough to be of
 * this place at all. A sign down a private lane can match a panorama two
 * hundred metres away on the main road, and a view from there is not a view
 * of the sign however accurately the camera is aimed.
 */
export function metresBetween(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);

  const h =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far from the camera the sign is, and therefore how wide a view to ask
 * for.
 *
 * Street View's `fov` is the horizontal field of view in degrees: smaller is
 * more zoomed in. A sign photographed from across a junction needs a narrow
 * field or it comes out as a smudge in the middle of a wide street scene; one
 * directly overhead needs a wide field or it does not fit in the frame.
 *
 * The numbers are chosen to bracket, not to be exact - the real framing
 * depends on the sign's size and mounting height, which the listing may not
 * declare. A person confirms the result either way.
 */
export function suggestedFov(distanceMetres: number): number {
  if (distanceMetres < 12) return 90;
  if (distanceMetres < 30) return 70;
  if (distanceMetres < 60) return 50;
  return 35;
}

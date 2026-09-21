import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { bearingDegrees, metresBetween, suggestedFov, type LatLng } from "@/lib/geo";
import { prisma } from "./db";
import { imageUrl } from "./storage";
import { streetViewKeyFor } from "./storage/streetview";

/**
 * Street View, aimed.
 *
 * The listing page used to embed Street View with the sign's coordinates and
 * nothing else. Google then snapped to whichever panorama was nearest and
 * faced the camera wherever that panorama happened to face, which on a corner
 * plot is a different street - the page said "this is the site" and showed
 * somewhere else. That was the bug.
 *
 * Fixing it needs two facts the embed was never given: which panorama, and
 * which way to look from it. Both come from the Street View **metadata**
 * endpoint, which returns the panorama's id, its real position and its
 * capture date, and returns no imagery at all. Google documents it as free
 * and unmetered, which is also why it is safe to call on a page render.
 *
 * With the panorama's true position in hand the heading is arithmetic:
 * the bearing from where the camera stands to where the sign is (lib/geo.ts).
 *
 * The key. This reads the same NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY the embed
 * uses, and the metadata and static endpoints must be enabled for it in the
 * Google Cloud console - they are separate APIs from the Embed API, and an
 * unenabled one answers with a REQUEST_DENIED status rather than an error.
 * That case is handled like any other "no panorama": nothing is shown.
 */

const METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const STATIC_URL = "https://maps.googleapis.com/maps/api/streetview";
const TIMEOUT_MS = 6_000;

/**
 * Beyond this, the nearest panorama is not a view of this place.
 *
 * A sign down a private lane or inside a yard can match a panorama out on the
 * main road, and pointing the camera accurately at a point 200m away through
 * two buildings produces a confident picture of the wrong thing.
 */
export const MAX_PANO_DISTANCE_M = 80;

export function streetViewKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY?.trim() || null;
}

/**
 * A short memory of which panorama belongs to which coordinate.
 *
 * The admin queue renders this panel once per listing on the page, and the
 * listing page renders it on every view: without a memo, opening the queue is
 * twenty round trips to Google before anything paints. A panorama for a fixed
 * point changes when Google re-drives the street, which is a matter of years,
 * so hours is a conservative life for this.
 *
 * In-process and bounded, like server/rate-limit.ts: it is a latency memo, not
 * a store. It is empty after a restart, and on this host that happens often.
 * Nothing depends on it being warm and no imagery is ever held here - only the
 * id, the position and the date.
 */
const CACHE_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; view: PanoView | null }>();

function cacheKey(target: LatLng): string {
  // Five decimals is about a metre - finer than the coordinate a listing
  // carries, and coarse enough that the same sign hits the same entry.
  return `${target.lat.toFixed(5)},${target.lng.toFixed(5)}`;
}

export type PanoView = {
  panoId: string;
  /** Where the camera actually stands, which is not where the sign is. */
  camera: LatLng;
  /** Degrees clockwise from north, from the camera towards the sign. */
  heading: number;
  /** Horizontal field of view, narrowed for a sign further away. */
  fov: number;
  metresAway: number;
  /** Google's own capture date, "YYYY-MM". Shown, never guessed at. */
  capturedAt: string | null;
  copyright: string | null;
};

type MetadataResponse = {
  status?: string;
  pano_id?: string;
  location?: { lat?: number; lng?: number };
  date?: string;
  copyright?: string;
};

/**
 * Find the panorama for a sign, and work out how to look at it from there.
 *
 * Returns null for every unhappy case - no coverage, an API that is not
 * enabled, a network failure, a panorama too far away to be of this place.
 * The callers all treat null the same way: show no Street View, which is
 * what the page did before this existed and is never wrong.
 */
export async function lookupPano(target: LatLng): Promise<PanoView | null> {
  const key = streetViewKey();
  if (!key) return null;

  const memo = cache.get(cacheKey(target));
  // A null is cached too. "No coverage here" is the answer for most of the
  // country, and re-asking Google on every render of a listing that will
  // never have a panorama is the expensive way to learn nothing.
  if (memo && Date.now() - memo.at < CACHE_TTL_MS) return memo.view;

  const view = await fetchPano(target, key);

  // Bounded by throwing the whole thing away rather than by evicting the
  // oldest entry: this is a latency memo, the cost of a cold start is one
  // request, and an LRU here would be machinery in service of nothing.
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(cacheKey(target), { at: Date.now(), view });
  return view;
}

async function fetchPano(target: LatLng, key: string): Promise<PanoView | null> {
  const url =
    `${METADATA_URL}?location=${target.lat},${target.lng}` +
    `&source=outdoor&key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as MetadataResponse;

    // "ZERO_RESULTS" is ordinary - much of the country has no coverage.
    // "REQUEST_DENIED" means the API is not enabled for this key, which is a
    // configuration fact rather than a fault, and is logged once rather than
    // thrown: a missing panel is better than a broken page.
    if (body.status !== "OK") {
      if (body.status === "REQUEST_DENIED") {
        console.error("[velto] Street View metadata denied - is the API enabled for this key?");
      }
      return null;
    }

    const lat = body.location?.lat;
    const lng = body.location?.lng;
    if (typeof lat !== "number" || typeof lng !== "number" || !body.pano_id) return null;

    const camera = { lat, lng };
    const metresAway = metresBetween(camera, target);
    if (metresAway > MAX_PANO_DISTANCE_M) return null;

    return {
      panoId: body.pano_id,
      camera,
      // The whole point: look from the road towards the sign, rather than
      // wherever the car happened to be pointing.
      heading: Math.round(bearingDegrees(camera, target)),
      fov: suggestedFov(metresAway),
      metresAway: Math.round(metresAway),
      capturedAt: body.date ?? null,
      copyright: body.copyright ?? null,
    };
  } catch (err) {
    console.error("[velto] Street View metadata failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Static API URL for one framed view.
 *
 * Pinned to the panorama id rather than to coordinates, so the image cannot
 * drift to a different panorama between the metadata call and this one - and
 * so the same stored view renders the same picture next month.
 */
export function staticViewUrl(view: PanoView, size = "640x400"): string | null {
  const key = streetViewKey();
  if (!key) return null;
  return (
    `${STATIC_URL}?size=${size}` +
    `&pano=${encodeURIComponent(view.panoId)}` +
    `&heading=${view.heading}&fov=${view.fov}&pitch=10` +
    `&key=${encodeURIComponent(key)}`
  );
}

/**
 * The embed URL for the interactive panel.
 *
 * `pano` and `heading` are what make this show the sign. Without them the
 * Embed API picks both for itself, which is the bug this module exists for.
 */
export function embedViewUrl(view: PanoView): string | null {
  const key = streetViewKey();
  if (!key) return null;
  return (
    `https://www.google.com/maps/embed/v1/streetview` +
    `?key=${encodeURIComponent(key)}` +
    `&pano=${encodeURIComponent(view.panoId)}` +
    `&heading=${view.heading}&fov=${view.fov}&pitch=10`
  );
}

/**
 * Give a listing a Street View photograph, if there is one to give.
 *
 * This is the row that lets a listing with no owner photograph still show an
 * advertiser where their artwork would sit. It stores a description of a view
 * - panorama, heading, field of view - and no bytes; the frame is fetched from
 * Google when the image is requested and kept for the length of that request.
 *
 * Idempotent, and cheap to call: a listing that already has its Street View
 * row is left alone unless the panorama has changed, which happens when Google
 * re-drives a street and is a matter of years. Called from the admin scan and
 * when a listing is published.
 *
 * Returns the image id when there is one, null when the address has no usable
 * panorama - which is ordinary, and means the listing simply has no Street
 * View photograph, exactly as before this existed.
 */
export async function ensureStreetViewPhoto(assetId: string): Promise<string | null> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { id: true, latitude: true, longitude: true },
  });
  if (!asset) return null;

  const view = await lookupPano({ lat: asset.latitude, lng: asset.longitude });
  if (!view) return null;

  const key = streetViewKeyFor(view);
  const existing = await prisma.mediaAssetImage.findFirst({
    where: { assetId, storageProvider: "streetview" },
    select: { id: true, storageKey: true },
  });

  if (existing) {
    if (existing.storageKey === key) return existing.id;
    /*
     * The street was re-driven and the old panorama is gone.
     *
     * The quad goes with it. Four corners marked on last year's frame land on
     * a different part of a new one - possibly on a building - and keeping
     * them would put an advertiser's artwork somewhere arbitrary while still
     * looking deliberate. Better no preview than a wrong one.
     */
    await prisma.mediaAssetImage.update({
      where: { id: existing.id },
      data: {
        storageKey: key,
        surfaceQuad: Prisma.DbNull,
        surfaceSource: null,
        surfaceConfidence: null,
        surfaceCheckedAt: null,
      },
    });
    return existing.id;
  }

  const id = randomUUID();
  await prisma.mediaAssetImage.create({
    data: {
      id,
      assetId,
      url: imageUrl(id),
      storageKey: key,
      storageProvider: "streetview",
      // Never primary. The owner's own photograph is the listing's face; this
      // is a fallback and a second angle, and promoting Google's frame over a
      // photo the owner chose would be the wrong way round.
      isPrimary: false,
      sortOrder: 900,
    },
  });
  return id;
}

/** Whether this row's bytes come from Google rather than from the owner. */
export function isStreetViewImage(image: { storageProvider: string | null }): boolean {
  return image.storageProvider === "streetview";
}

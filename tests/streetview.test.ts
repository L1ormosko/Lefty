import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which panorama, and which way to look from it.
 *
 * The bug: the listing page embedded Street View with the sign's coordinates
 * and nothing else, so Google chose the panorama AND the direction. On a
 * corner plot it showed the other street - a page claiming to show the site
 * and showing somewhere else, which is worse than showing nothing at all.
 *
 * Every test here is about a way that can still go wrong, because the failure
 * mode is not an error message. It is a confident picture of the wrong place.
 */

const BEER_SHEVA = { lat: 31.2518, lng: 34.7913 };

const metadata = (body: object) =>
  new Response(JSON.stringify(body), { status: 200 }) as never;

/** A camera on the road just south of the sign, so it must look north. */
const SOUTH_OF_IT = {
  status: "OK",
  pano_id: "PANO123",
  location: { lat: 31.2513, lng: 34.7913 },
  date: "2024-06",
  copyright: "© Google",
};

let saved: string | undefined;
let streetview: typeof import("@/server/streetview");

beforeEach(async () => {
  saved = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY = "test-key";
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Re-imported per test: the module holds a process-lifetime memo, and a
  // cached answer from the previous test would make the next one pass
  // without ever calling the code under test.
  vi.resetModules();
  streetview = await import("@/server/streetview");
});

afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;
  else process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY = saved;
  vi.restoreAllMocks();
});

describe("finding the panorama", () => {
  it("points the camera from where it stands towards the sign", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata(SOUTH_OF_IT));

    const view = await streetview.lookupPano(BEER_SHEVA);

    expect(view).not.toBeNull();
    expect(view!.panoId).toBe("PANO123");
    // The camera is south of the sign, so it has to look north - 0 degrees.
    // This is the whole bug in one assertion.
    expect(view!.heading).toBe(0);
    expect(view!.capturedAt).toBe("2024-06");
  });

  it("reports the distance rather than implying the camera is at the sign", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata(SOUTH_OF_IT));
    const view = await streetview.lookupPano(BEER_SHEVA);
    // ~55m: the panorama is on the road, the sign is set back from it.
    expect(view!.metresAway).toBeGreaterThan(40);
    expect(view!.metresAway).toBeLessThan(70);
  });

  it("refuses a panorama too far away to be of this place", async () => {
    // A sign down a private lane matches a panorama out on the main road.
    // Aiming accurately at a point 300m away through two buildings gives a
    // confident picture of the wrong thing.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      metadata({ ...SOUTH_OF_IT, location: { lat: 31.2488, lng: 34.7913 } })
    );
    expect(await streetview.lookupPano(BEER_SHEVA)).toBeNull();
  });

  it("returns nothing where there is no coverage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata({ status: "ZERO_RESULTS" }));
    expect(await streetview.lookupPano(BEER_SHEVA)).toBeNull();
  });

  it("returns nothing, loudly, when the API is not enabled for the key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata({ status: "REQUEST_DENIED" }));

    expect(await streetview.lookupPano(BEER_SHEVA)).toBeNull();
    // A configuration fact worth finding in a log, since the symptom on
    // screen is a panel that is simply absent.
    expect(log).toHaveBeenCalled();
  });

  it("returns nothing without a key, and asks Google nothing", async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await streetview.lookupPano(BEER_SHEVA)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("survives a malformed answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      metadata({ status: "OK", pano_id: "X", location: {} })
    );
    expect(await streetview.lookupPano(BEER_SHEVA)).toBeNull();
  });

  it("survives the network being gone", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    expect(await streetview.lookupPano(BEER_SHEVA)).toBeNull();
  });
});

describe("not asking twice", () => {
  it("remembers an answer instead of re-asking on every render", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata(SOUTH_OF_IT));

    await streetview.lookupPano(BEER_SHEVA);
    await streetview.lookupPano(BEER_SHEVA);
    await streetview.lookupPano(BEER_SHEVA);

    // The admin queue renders this panel once per listing on the page.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("remembers a negative answer too", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(metadata({ status: "ZERO_RESULTS" }));

    await streetview.lookupPano(BEER_SHEVA);
    await streetview.lookupPano(BEER_SHEVA);

    // Most of the country has no coverage; re-asking about a listing that
    // will never have a panorama is the expensive way to learn nothing.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the URLs", () => {
  it("pins the embed to the panorama, not to a coordinate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata(SOUTH_OF_IT));
    const view = await streetview.lookupPano(BEER_SHEVA);

    const url = streetview.embedViewUrl(view!)!;
    // `pano` is what stops Google choosing a different panorama than the one
    // the heading was computed for - which would aim the camera precisely at
    // the wrong thing.
    expect(url).toContain("pano=PANO123");
    expect(url).toContain("heading=0");
    expect(url).not.toContain("location=");
  });

  it("builds a static frame from the same panorama and heading", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata(SOUTH_OF_IT));
    const view = await streetview.lookupPano(BEER_SHEVA);

    const url = streetview.staticViewUrl(view!, "640x400")!;
    expect(url).toContain("pano=PANO123");
    expect(url).toContain("heading=0");
    expect(url).toContain("size=640x400");
  });

  it("builds no URL without a key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(metadata(SOUTH_OF_IT));
    const view = await streetview.lookupPano(BEER_SHEVA);
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;

    expect(streetview.embedViewUrl(view!)).toBeNull();
    expect(streetview.staticViewUrl(view!)).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectSurface, detectionEnabled } from "@/server/surface";

/**
 * What the detector does with every answer a model can give.
 *
 * The property under test is not "does it work when the model is right" -
 * that needs a real photograph and is checked by hand. It is that no answer,
 * including a hostile or broken one, can reach the database as a face. These
 * corners decide where a customer's artwork is drawn on a photograph of a
 * real location, so the failure that matters is a bad quad getting through,
 * not a good one being missed.
 */

const IMAGE = { data: new Uint8Array([1, 2, 3]), contentType: "image/webp" };
const CONTEXT = {
  assetType: "BILLBOARD",
  address: "דרך חברון 42",
  city: "באר שבע",
  widthCm: 900,
  heightCm: 300,
};

const square = [
  { x: 0.2, y: 0.3 },
  { x: 0.8, y: 0.3 },
  { x: 0.8, y: 0.6 },
  { x: 0.2, y: 0.6 },
];

/** An Anthropic messages response carrying `text` as the model's reply. */
const reply = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 }) as never;

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe("without a key", () => {
  it("is off, and says so rather than failing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(detectionEnabled({} as NodeJS.ProcessEnv)).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await detectSurface(IMAGE, CONTEXT);

    // "skipped" and "none" are different states downstream: skipped leaves
    // the photo unchecked for a later run, none records that we looked.
    expect(result.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a usable answer", () => {
  it("is returned with its confidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: true, confidence: 0.91, corners: square }))
    );

    const result = await detectSurface(IMAGE, CONTEXT);
    expect(result).toMatchObject({ status: "found", confidence: 0.91 });
    expect(result.status === "found" && result.quad[0]).toEqual({ x: 0.2, y: 0.3 });
  });

  it("survives a code fence around the JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply("```json\n" + JSON.stringify({ found: true, confidence: 0.9, corners: square }) + "\n```")
    );
    expect((await detectSurface(IMAGE, CONTEXT)).status).toBe("found");
  });

  it("keeps a missing confidence as missing rather than inventing one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: true, corners: square }))
    );
    // Null travels to surfaceVerdict, which sends it to review. A default of
    // 1 here would show it; a default of 0 would look like a failed
    // detection. Neither is what happened.
    expect(await detectSurface(IMAGE, CONTEXT)).toMatchObject({
      status: "found",
      confidence: null,
    });
  });

  it("sends the declared dimensions so the model knows which sign is meant", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: true, confidence: 0.9, corners: square }))
    );
    await detectSurface(IMAGE, CONTEXT);

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]!.body));
    expect(body.system).toContain("900");
    expect(body.system).toContain("באר שבע");
    // And the photograph itself, base64, not a URL - the bytes are behind an
    // authorization check and a URL would be useless to the model.
    expect(body.messages[0].content[0].source.type).toBe("base64");
  });
});

describe("every way it can go wrong", () => {
  it("takes a refusal at face value", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: false, confidence: 0.2, corners: null }))
    );
    // "I cannot tell" is a useful answer and must not be second-guessed.
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("drops an answer with the wrong number of corners", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: true, confidence: 0.99, corners: square.slice(0, 3) }))
    );
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("drops corners that are nowhere near the photograph", async () => {
    const wild = [
      { x: 0.2, y: 0.3 },
      { x: 9, y: 0.3 },
      { x: 9, y: 0.6 },
      { x: 0.2, y: 0.6 },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: true, confidence: 0.99, corners: wild }))
    );
    // parseQuad's own bound, the same one an admin's typed value passes.
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("drops a non-numeric corner", async () => {
    const bad = [{ x: "left", y: 0.3 }, ...square.slice(1)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(JSON.stringify({ found: true, confidence: 0.99, corners: bad }))
    );
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("drops prose that is not JSON at all", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply("I can see a billboard on the left."));
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("drops JSON that is broken half way through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply('{"found": true, "corners": [{"x":'));
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("survives an error from the provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }) as never);
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("survives the network being gone", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    expect(await detectSurface(IMAGE, CONTEXT)).toEqual({ status: "none" });
  });

  it("gives up rather than hanging, and does not throw", async () => {
    // An abort surfaces as a rejection on the fetch promise; the point is
    // that an upload waiting on this can never be held open by it.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    );
    await expect(detectSurface(IMAGE, CONTEXT)).resolves.toEqual({ status: "none" });
  });
});

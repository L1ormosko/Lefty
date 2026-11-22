import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "./errors";

/** Largest JSON request body accepted (1 MB). Documented in docs/API_CONVENTIONS.md. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/**
 * JSON-only CSRF layer (docs/API_CONVENTIONS.md): a mutating request that carries a body must say
 * it is JSON. A cross-site HTML form or `fetch` without a CORS preflight can only send
 * form/text content types, so they are refused before any parsing. Requests with no body are not
 * affected (and SameSite=Lax cookies are not sent on cross-site POSTs anyway).
 *
 * @throws UnsupportedMediaTypeError
 */
export function assertJsonContentType(req: Request): void {
  if (!MUTATING_METHODS.has(req.method) || req.body === null) return;
  if (!isJsonContentType(req.headers.get("content-type"))) {
    throw new UnsupportedMediaTypeError();
  }
}

/** Reads the body as text, refusing more than `MAX_JSON_BODY_BYTES` without buffering the excess. */
async function readTextWithLimit(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) throw new PayloadTooLargeError();
  if (req.body === null) return "";

  // content-length can be absent or wrong (chunked uploads), so count the bytes actually read.
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parses the request body as JSON. GET/HEAD have none; an empty body is `undefined`.
 * @throws UnsupportedMediaTypeError, PayloadTooLargeError, ValidationError (not valid JSON)
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  assertJsonContentType(req);
  const text = await readTextWithLimit(req);
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError({ message: "The request body is not valid JSON.", field: "body" });
  }
}

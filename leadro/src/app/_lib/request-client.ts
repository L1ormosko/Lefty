import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { clientInfoFromRequest, type ClientInfo } from "@/server/auth";

/**
 * `ClientInfo` (IP, user agent, correlation id) for a server action or page. Reuses the auth
 * module's IP rules (trusted-proxy hops) by wrapping the incoming headers in a `Request`.
 */
export async function getClientInfo(): Promise<ClientInfo> {
  const incoming = await headers();
  const request = new Request("http://localhost/", { headers: new Headers(incoming) });
  return clientInfoFromRequest(request, { correlationId: randomUUID(), sourceApp: "WEB" });
}

/**
 * Browser same-origin POSTs may omit Origin while still sending a same-origin
 * Referer. Accept either browser provenance signal, but never accept a
 * missing or cross-origin signal for a state-changing request.
 */
export function isSameOriginMutation(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host") || requestUrl.host;
  const requestProtocol = forwardedProtocol ? `${forwardedProtocol.replace(/:$/, "")}:` : requestUrl.protocol;
  const requestOrigin = `${requestProtocol}//${requestHost}`;
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === requestOrigin; } catch { return false; }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try { return new URL(referer).origin === requestOrigin; } catch { return false; }
  }

  return request.headers.get("sec-fetch-site") === "same-origin";
}

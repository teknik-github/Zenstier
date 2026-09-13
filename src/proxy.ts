import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route protection plus security headers.
 *
 * The auth check here only looks for a session cookie so the proxy stays cheap
 * and never touches the database. It is NOT an authorisation boundary: every
 * Server Action, Route Handler and page performs its own permission check,
 * because Server Actions are reachable by direct POST regardless of what
 * matches here.
 */
const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

const PUBLIC_PATHS = ["/login", "/register", "/invite"];

function buildCsp(nonce: string, isDev: boolean, isSecure: boolean): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next's bootstrap script load its own chunks while
    // still rejecting anything an injection would add.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind and next/font emit inline <style>; nonce-ing every one of them
    // is not reliable, and inline CSS is a far weaker vector than inline JS.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    // Same-origin only: the SSE stream and Server Actions both live here.
    // Dev additionally needs the HMR websocket, which 'self' does not cover.
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    // Only when the connection is ALREADY TLS. Sent over plain HTTP it makes
    // the browser rewrite every subresource to https:// and the page breaks —
    // which is exactly what happens on a LAN deployment without a certificate.
    ...(isSecure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  // Trust the forwarded header first: behind a TLS-terminating proxy the
  // request reaches Next as plain HTTP.
  const isSecure =
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";
  const csp = buildCsp(nonce, isDev, isSecure);

  const applySecurityHeaders = (response: NextResponse) => {
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
    // HSTS is meaningless (and per RFC 6797 must be ignored) over plain HTTP,
    // and pinning a bare LAN IP to HTTPS would lock the dashboard out.
    if (isSecure && !isDev) {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
    }
    return response;
  };

  if (!hasSession && !isPublic) {
    const url = new URL("/login", request.url);
    url.searchParams.set("callbackUrl", pathname);
    return applySecurityHeaders(NextResponse.redirect(url));
  }

  if (hasSession && isPublic && pathname !== "/invite") {
    return applySecurityHeaders(
      NextResponse.redirect(new URL("/dashboard", request.url)),
    );
  }

  // Next reads the nonce back off the request headers to stamp its own tags.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  return applySecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
  );
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals, static assets and the auth API
     * (which must stay reachable while logged out). Prefetches are skipped:
     * they render no document and would only burn nonces.
     */
    {
      source:
        "/((?!api/auth|api/v1/agent|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

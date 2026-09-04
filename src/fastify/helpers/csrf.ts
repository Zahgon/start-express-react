/*
  Purpose:
  Collection of shared Fastify hooks used across the API.

  This file intentionally contains only:
  - Stateless hooks
  - Security-related cross-cutting concerns

  No business logic should live here.

  Related docs:
  - https://fastify.dev/docs/latest/Reference/Hooks/
  - https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
  - https://github.com/Psifi-Solutions/csrf-csrf/blob/main/FAQ.md
*/

import type { FastifyRequest, onRequestAsyncHookHandler } from "fastify";

/* ************************************************************************ */
/* CSRF protection (Client-side double-submit pattern)                      */
/* ************************************************************************ */

/*
  Default CSRF configuration.

  Design choices:
  - Uses a double-submit cookie strategy
  - Requires no server-side storage (stateless)
  - Designed for same-site React + Fastify architecture

  cookieName:
  - Uses "__Host-" prefix to enforce:
    * Secure context
    * Path=/
    * No Domain attribute
    (enforced by modern browsers)

  ignoredMethods:
  - Safe HTTP methods do not mutate state and are not protected

  getCsrfTokenFromRequest:
  - Allows customizing how the token is read (header, body, etc.)
*/
const csrfDefaults = {
  cookieName: "__Host-x-csrf-token",
  ignoredMethods: ["GET", "HEAD", "OPTIONS"],
  getCsrfTokenFromRequest: (request: FastifyRequest) =>
    request.headers["x-csrf-token"],
};

/*
  csrf()

  Factory returning a Fastify onRequest hook.

  Why an onRequest hook?
  - It is the earliest step of the Fastify lifecycle
  - It runs before body parsing, so payloads of rejected requests are never
    parsed (this mirrors the "csrf() before json()" ordering of the Express
    implementation)

  Why a factory?
  - Allows overriding defaults per instance if needed
  - Keeps global configuration explicit and testable

  Security model:
  - For mutative requests:
      * Read CSRF token from request (header)
      * Compare it with the value stored in the cookie
  - Reject if missing or mismatching
*/
export const csrf =
  ({
    cookieName,
    ignoredMethods,
    getCsrfTokenFromRequest,
  } = csrfDefaults): onRequestAsyncHookHandler =>
  async (request, reply) => {
    /*
      Skip CSRF validation for safe methods.
      This keeps read-only endpoints frictionless.
    */
    if (
      request.method.match(new RegExp(`(${ignoredMethods.join("|")})`, "i"))
    ) {
      return;
    }

    const tokenFromRequest = getCsrfTokenFromRequest(request);
    const tokenFromCookie = request.cookies[cookieName];

    /*
      Reject the request if:
      - the CSRF header is missing
      - or the header and cookie do not match

      Why 401 and not 403?
      Using 401 makes CSRF failures indistinguishable from JWT
      authentication failures. An attacker receiving 403 would know
      their JWT is valid and only the CSRF token is wrong.
      A uniform 401 reveals nothing about what specifically failed.

      Returning the reply tells Fastify the lifecycle is over.
    */
    if (tokenFromRequest == null || tokenFromRequest !== tokenFromCookie) {
      reply.code(401).send();
      return reply;
    }
  };

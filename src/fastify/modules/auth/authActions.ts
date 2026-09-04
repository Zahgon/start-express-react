/*
  Purpose:
  Centralize all authentication-related actions and hooks.

  This file handles:
  - User authentication (magic link)
  - JWT creation and verification
  - Authentication cookie management

  This file intentionally does NOT:
  - Handle routing concerns (handled by authRoutes)
  - Implement authorization logic (handled elsewhere)

  Security model:
  - Stateless authentication via JWT stored in HttpOnly cookies
  - Medium-lived tokens (7 days)
*/

import crypto from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { preHandlerAsyncHookHandler, RouteHandler } from "fastify";
import jwt, { type JwtPayload } from "jsonwebtoken";
import nodemailer from "nodemailer";

import { serverEnv } from "../../../env/server";
import userRepository from "../user/userRepository";
import authRepository from "./authRepository";

/*
  Extend FastifyRequest to carry authenticated user data.
  This is populated exclusively by verifyAccessToken.
*/
declare module "fastify" {
  interface FastifyRequest {
    me: User;
  }
}

/* ************************************************************************ */
/* Security options                                                         */
/* ************************************************************************ */

const magicLinkTimeout = 15 * 60 * 1000; // 15 minutes

/*
  Lifetime of an authentication session.

  NOTE:
  Fastify cookies express `maxAge` in seconds (Set-Cookie semantics), while
  jsonwebtoken expects a number of seconds for `expiresIn`. The value handed to
  `expiresIn` is deliberately kept identical to the Express implementation, so
  the migration does not silently change token lifetimes.
*/
const sessionMaxAge = 7 * 24 * 60 * 60 * 1000; // 7 days, in milliseconds

/*
  Cookie configuration for authentication token.

  Notes:
  - HttpOnly: inaccessible to JavaScript
  - SameSite=strict: mitigates CSRF
  - Secure: HTTPS only
  - Path=/: required by the "__Host-" prefix
*/
const cookieOptions: CookieSerializeOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
  maxAge: sessionMaxAge / 1000, // seconds
};

/*
  Minimal JWT wrapper to:
  - Encapsulate signing and verification
  - Enforce payload typing between sign and verify methods
*/
class TokenSigner<Payload extends JwtPayload | string = JwtPayload> {
  #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
  }

  signSession(payload: Payload): string {
    return jwt.sign(payload, this.#secret, { expiresIn: sessionMaxAge });
  }

  verify(token: string): Payload {
    return jwt.verify(token, this.#secret) as Payload;
  }
}

const tokenSigner = new TokenSigner(serverEnv.APP_SECRET);

const transporter = serverEnv.SMTP_URL
  ? nodemailer.createTransport({
      url: serverEnv.SMTP_URL,
      ...(serverEnv.DKIM_PRIVATE_KEY &&
        serverEnv.DKIM_DOMAIN && {
          dkim: {
            domainName: serverEnv.DKIM_DOMAIN,
            keySelector: serverEnv.DKIM_SELECTOR,
            privateKey: serverEnv.DKIM_PRIVATE_KEY,
          },
        }),
    })
  : null;

const trustedBaseUrl = serverEnv.APP_BASE_URL.replace(/\/+$/, "");

/* ************************************************************************ */
/* Route generics                                                           */
/* ************************************************************************ */

/*
  Bodies are intentionally loose: these two endpoints validate their own input
  and answer 400 themselves, so they must be able to observe a missing or
  malformed payload.
*/
export type MagicLinkRoute = { Body: { email?: unknown } | undefined };
export type VerifyRoute = { Body: { token?: unknown } | undefined };

/* ************************************************************************ */
/* Actions                                                                  */
/* ************************************************************************ */

/*
  Send a magic link to the user's email.

  Response:
  - 204 on success
*/
const sendMagicLink: RouteHandler<MagicLinkRoute> = async (request, reply) => {
  const email = request.body?.email;

  if (!email || typeof email !== "string") {
    reply.code(400).send();
    return;
  }

  // Find or create user ID
  const userId = userRepository.findByEmailOrCreate(email);

  // Generate opaque token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  // Store in DB
  const expiresAt = new Date(Date.now() + magicLinkTimeout);
  authRepository.insertOrReplaceToken(userId, tokenHash, expiresAt);

  const magicLink = `${trustedBaseUrl}/verify?token=${rawToken}`;

  if (transporter) {
    await transporter.sendMail({
      from: "starter@mail.com",
      to: email,
      subject: "Login link",
      html: `<a href="${magicLink}">Click here to login</a>`,
    });
  } else {
    console.info("----------------------------------------------------------");
    console.info(`Magic Link for ${email}:`);
    console.info(magicLink);
    console.info("----------------------------------------------------------");
  }

  reply.code(204).send();
};

/* ************************************************************************ */

/*
  Authenticate an existing user and issue an access token.

  Response:
  - 201 with user
  - 401 on error
*/
const verifyMagicLink: RouteHandler<VerifyRoute> = async (request, reply) => {
  const token = request.body?.token;

  if (!token || typeof token !== "string") {
    reply.code(400).send();
    return;
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const storedToken = authRepository.findByHash(tokenHash);

    if (storedToken == null) {
      throw new Error("Invalid token");
    }

    if (storedToken.consumed_at != null) {
      throw new Error("Token already consumed");
    }

    if (new Date(storedToken.expires_at) < new Date()) {
      throw new Error("Token expired");
    }

    // Mark as consumed
    authRepository.markAsConsumed(storedToken.user_id);

    const user = userRepository.find(storedToken.user_id);

    if (user == null) {
      throw new Error("User not found");
    }

    const sessionToken = tokenSigner.signSession({ sub: user.id.toString() });

    reply.setCookie("__Host-auth", sessionToken, cookieOptions);

    reply.code(201).send(user);
  } catch {
    reply.code(401).send();
  }
};

/* ************************************************************************ */

/*
  Destroy the authentication cookie.

  Notes:
  - Stateless logout: token invalidation relies on expiration
*/
const destroyAccessToken: RouteHandler = async (_request, reply) => {
  reply.clearCookie("__Host-auth", cookieOptions);

  reply.code(204).send();
};

/* ************************************************************************ */
/* Hooks                                                                    */
/* ************************************************************************ */

/*
  Verify the access token from cookies and attach the user to request.me.

  Preconditions:
  - @fastify/cookie has already parsed the cookies

  Response:
  - 401 if token is missing or invalid
*/
const verifyAccessToken: preHandlerAsyncHookHandler = async (
  request,
  reply,
) => {
  try {
    const token = request.cookies["__Host-auth"];

    if (token == null) {
      throw new Error("Access token is missing in cookies");
    }

    const payload = tokenSigner.verify(token);

    const me = userRepository.find(Number(payload.sub));

    if (me == null) {
      throw new Error("User not found");
    }

    // Refresh cookie (extends expiration)
    const freshToken = tokenSigner.signSession({ sub: me.id.toString() });
    reply.setCookie("__Host-auth", freshToken, cookieOptions);

    request.me = me;
  } catch {
    reply.code(401).send();
    return reply;
  }
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default {
  sendMagicLink,
  verifyMagicLink,
  destroyAccessToken,
  verifyAccessToken,
};

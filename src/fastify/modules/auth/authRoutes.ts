/*
  Purpose:
  Routes related to "auth" actions.

  This file defines:
  - Magic link endpoints
  - Authenticated "me" endpoint

  Guiding principles:
  - Magic link access is public
  - Me access is authenticated

  Related docs:
  - https://restfulapi.net/resource-naming/
  - https://fastify.dev/docs/latest/Reference/Routes/
*/

/* ************************************************************************ */
/* Plugin setup                                                             */
/* ************************************************************************ */

import type { FastifyPluginAsync } from "fastify";

/* ************************************************************************ */
/* Dependencies                                                             */
/* ************************************************************************ */

/*
  authActions:
  - Thin controllers
  - One action per route
*/
import authActions, {
  type MagicLinkRoute,
  type VerifyRoute,
} from "./authActions";

/* ************************************************************************ */
/* Public routes                                                            */
/* ************************************************************************ */

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<MagicLinkRoute>(
    "/api/auth/magic-link",
    authActions.sendMagicLink,
  );
  fastify.post<VerifyRoute>("/api/auth/verify", authActions.verifyMagicLink);
  fastify.post("/api/auth/logout", authActions.destroyAccessToken);
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default authRoutes;

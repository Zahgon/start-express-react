/*
  Purpose:
  Routes related to "users" resources.

  This file defines:
  - Authenticated endpoints

  Guiding principles:
  - Users can only access their own data

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
  avatarUploader:
  - Handles avatar file uploads
  - Validates file type and size
*/
import { createUploader } from "../../helpers/upload";
/*
  authActions:
  - verifyAccessToken injects `request.me`
  - `request.me` contains the authenticated user
*/
import authActions from "../auth/authActions";
/*
  userActions:
  - Thin controllers
  - One action per route
*/
import userActions from "./userActions";
/*
  userValidators:
  - Validates request payloads
  - Prevents invalid data from reaching actions
*/
import userValidators from "./userValidators";

const avatarUploader = createUploader({
  subfolder: "avatars",
  maxSizeBytes: 2 * 1024 * 1024,
});

/* ************************************************************************ */
/* Route constants                                                          */
/* ************************************************************************ */

/*
  Paths are declared once to:
  - Avoid duplication
  - Make refactors trivial
*/
const ME_PATH = "/api/users/me";
const ME_AVATAR_PATH = "/api/users/me/avatar";

/* ************************************************************************ */
/* Authenticated routes                                                     */
/* ************************************************************************ */

/*
  User-specific routes.
  - Authentication is enforced
  - Users can only access their own data
*/
const userRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    ME_PATH,
    { preHandler: [authActions.verifyAccessToken] },
    userActions.readMe,
  );
  fastify.put<{ Body: Omit<User, "avatar_url"> }>(
    ME_PATH,
    { preHandler: [authActions.verifyAccessToken, userValidators.editMe] },
    userActions.editMe,
  );
  fastify.delete(
    ME_PATH,
    { preHandler: [authActions.verifyAccessToken] },
    userActions.destroyMe,
  );

  fastify.post(
    ME_AVATAR_PATH,
    {
      preHandler: [
        authActions.verifyAccessToken,
        avatarUploader.single("avatar"),
      ],
    },
    userActions.uploadMeAvatar,
  );
  fastify.delete(
    ME_AVATAR_PATH,
    { preHandler: [authActions.verifyAccessToken] },
    userActions.deleteMeAvatar,
  );
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default userRoutes;

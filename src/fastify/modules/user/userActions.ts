/*
  Purpose:
  Define HTTP request handlers for User-related operations.

  This file:
  - Translates HTTP requests into repository calls
  - Shapes HTTP responses (status codes and payloads)
  - Assumes all upstream guarantees are already satisfied

  What this file intentionally does NOT do:
  - No authentication (handled by the auth preHandler)
  - No authorization (handled by route-level checks)
  - No input validation (handled by validators)
  - No database logic (handled by repositories)

  Design notes:
  - Each handler maps closely to a single use case
  - Side effects are explicit and minimal
  - Handlers remain thin to keep behavior easy to audit
*/

import type { RouteHandler } from "fastify";

import { deleteUploadedFile } from "../../helpers/upload";
import userRepository from "./userRepository";

/* ************************************************************************ */
/* Handlers                                                                 */
/* ************************************************************************ */

/*
  Return the currently authenticated user.

  Preconditions:
  - verifyAccessToken has run successfully
*/
const readMe: RouteHandler = async (request, reply) => {
  reply.send(request.me);
};

/* ************************************************************************ */

/*
  Edit the currently authenticated user.

  Preconditions:
  - User is authenticated
  - request.body has been validated and sanitized

  Response:
  - 204 No Content on success
*/
const editMe: RouteHandler<{ Body: Omit<User, "avatar_url"> }> = async (
  request,
  reply,
) => {
  userRepository.update(request.body);

  reply.code(204).send();
};

/* ************************************************************************ */

/*
  Soft-delete the currently authenticated user.

  Preconditions:
  - User is authenticated

  Response:
  - 204 No Content
*/
const destroyMe: RouteHandler = async (request, reply) => {
  userRepository.softDelete(request.me.id);

  reply.code(204).send();
};

/* ************************************************************************ */

/*
  Upload avatar image for the currently authenticated user.

  Preconditions:
  - User is authenticated
  - The uploader preHandler has processed and attached request.uploadedFile
*/
const uploadMeAvatar: RouteHandler = async (request, reply) => {
  if (!request.uploadedFile) {
    reply.code(400).send({ message: "No file attached" });
    return;
  }

  const oldAvatarUrl = request.me.avatar_url;
  const newAvatarUrl = `/uploads/avatars/${request.uploadedFile.filename}`;

  userRepository.updateAvatar(request.me.id, newAvatarUrl);
  deleteUploadedFile(oldAvatarUrl);

  reply.code(201).send({ avatar_url: newAvatarUrl });
};

/* ************************************************************************ */

/*
  Delete avatar image for the currently authenticated user.

  Preconditions:
  - User is authenticated
*/
const deleteMeAvatar: RouteHandler = async (request, reply) => {
  const oldAvatarUrl = request.me.avatar_url;

  userRepository.updateAvatar(request.me.id, null);
  deleteUploadedFile(oldAvatarUrl);

  reply.code(204).send();
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default {
  readMe,
  editMe,
  destroyMe,
  uploadMeAvatar,
  deleteMeAvatar,
};

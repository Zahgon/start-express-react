/*
  Purpose:
  Convert the `:userId` route parameter into a fully loaded User.

  This module:
  - Centralizes user lookup logic
  - Attaches the resolved user to the request object
  - Stops the request early if the user does not exist

  Why this exists:
  - Avoids duplicated lookup code in controllers
  - Guarantees `request.user` for downstream handlers
  - Keeps route handlers small and predictable

  Related docs:
  - https://fastify.dev/docs/latest/Reference/Hooks/#prehandler
*/

/* ************************************************************************ */
/* Request augmentation                                                     */
/* ************************************************************************ */

/*
  Extend FastifyRequest to include `user`.

  After this preHandler runs successfully:
  - `request.user` is always defined
  - Controllers and guards can rely on it without null checks
*/
declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}

/*
  Export converter
*/
import { createParamConverter } from "../../helpers/paramConverter";
import userRepository from "./userRepository";

export default createParamConverter(userRepository, "user");

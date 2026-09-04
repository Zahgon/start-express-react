/*
  Purpose:
  Routes related to "items" resources.

  This file defines:
  - Public read endpoints
  - Authenticated write endpoints
  - Ownership-based authorization rules

  Guiding principles:
  - Read access is public
  - Write access is authenticated
  - Mutations are restricted to resource owners

  Related docs:
  - https://restfulapi.net/resource-naming/
  - https://fastify.dev/docs/latest/Reference/Routes/
  - https://fastify.dev/docs/latest/Reference/Hooks/#prehandler
*/

/* ************************************************************************ */
/* Plugin setup                                                             */
/* ************************************************************************ */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

/* ************************************************************************ */
/* Dependencies                                                             */
/* ************************************************************************ */

/*
  authActions:
  - verifyAccessToken injects `request.me`
  - `request.me` contains the authenticated user
*/
import authActions from "../auth/authActions";

/*
  itemActions:
  - Thin controllers
  - One action per route
*/
import itemActions from "./itemActions";
/*
  itemParamConverter:
  - Centralizes item lookup
  - Attaches `request.item`
  - Fails fast if item does not exist
*/
import itemParamConverter from "./itemParamConverter";
import type { ItemDTOWithUserId } from "./itemSchemas";

/*
  itemValidators:
  - Validates request payloads
  - Prevents invalid data from reaching actions
*/
import itemValidators from "./itemValidators";

/* ************************************************************************ */
/* Route constants                                                          */
/* ************************************************************************ */

/*
  Paths are declared once to:
  - Avoid duplication
  - Make refactors trivial
*/
const BASE_PATH = "/api/items";
const ITEM_PATH = "/api/items/:itemId";

/* ************************************************************************ */
/* Authorization rules                                                      */
/* ************************************************************************ */

/*
  Ownership check.

  Authorization logic is kept:
  - Explicit
  - Local to the resource
  - Easy to audit

  Assumptions:
  - request.item.user_id is the owner
  - request.me.id is the authenticated user id
*/
const checkAccess: preHandlerAsyncHookHandler = async (request, reply) => {
  if (request.item.user_id !== request.me.id) {
    reply.code(403).send();
    return reply;
  }
};

/* ************************************************************************ */
/* Routes                                                                   */
/* ************************************************************************ */

const itemRoutes: FastifyPluginAsync = async (fastify) => {
  /* ********************************************************************** */
  /* Public routes                                                          */
  /* ********************************************************************** */

  /*
    Public read-only endpoints.
    No authentication required.

    The param converter automatically resolves :itemId. After it runs:
    - request.item is guaranteed to exist
    - Downstream handlers can assume a valid item
  */
  fastify.get(BASE_PATH, itemActions.browse);
  fastify.get(
    ITEM_PATH,
    { preHandler: [itemParamConverter.convert] },
    itemActions.read,
  );

  /* ********************************************************************** */
  /* Authentication wall                                                    */
  /* ********************************************************************** */

  /*
    Everything below this line requires authentication.

    Fastify has no path-scoped middleware: the security boundary is expressed
    by listing verifyAccessToken first in each preHandler chain, which keeps
    the ordering explicit and auditable.
  */

  /*
    Create a new item.
    - Requires authentication
    - Validates payload before processing
  */
  fastify.post<{ Body: ItemDTOWithUserId }>(
    BASE_PATH,
    { preHandler: [authActions.verifyAccessToken, itemValidators.add] },
    itemActions.add,
  );

  /*
    Item-specific mutations.
    - Authentication enforced first
    - Ownership enforced via checkAccess
  */
  fastify.put<{ Body: Item }>(
    ITEM_PATH,
    {
      preHandler: [
        authActions.verifyAccessToken,
        itemParamConverter.convert,
        checkAccess,
        itemValidators.edit,
      ],
    },
    itemActions.edit,
  );

  fastify.delete(
    ITEM_PATH,
    {
      preHandler: [
        authActions.verifyAccessToken,
        itemParamConverter.convert,
        checkAccess,
      ],
    },
    itemActions.destroy,
  );
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default itemRoutes;

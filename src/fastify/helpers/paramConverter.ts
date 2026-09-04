/*
  Purpose:
  Provide shared utilities for Fastify modules.

  Related docs:
  - https://fastify.dev/docs/latest/Reference/Hooks/#prehandler
*/

import type { preHandlerAsyncHookHandler } from "fastify";

/* ************************************************************************ */
/* createParamConverter                                                     */
/* ************************************************************************ */

/*
  createParamConverter(repository, requestKey):
  - Returns a Fastify preHandler hook, meant to be attached to every route
    declaring a `:<requestKey>Id` parameter
  - Loads an entity from the repository and attaches it to request[requestKey]
  - Returns 404 if not found (or 204 for DELETE, for idempotency)

  Contract:
  - repository must expose a `find(id: number)` method returning T | null
*/
export const createParamConverter = <
  T extends { id: number },
  Repository extends { find: (id: T["id"]) => T | null },
>(
  repository: Repository,
  requestKey: string,
): { convert: preHandlerAsyncHookHandler } => {
  const paramName = `${requestKey}Id`;

  return {
    convert: async (request, reply) => {
      const params = request.params as Record<string, string | undefined>;
      const entity = repository.find(Number(params[paramName]));

      if (entity == null) {
        reply.code(request.method === "DELETE" ? 204 : 404).send();
        return reply;
      }

      Object.assign(request, { [requestKey]: entity });
    },
  };
};

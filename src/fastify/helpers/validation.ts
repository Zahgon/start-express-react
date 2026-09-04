/*
  Purpose:
  Provide shared utilities for Fastify modules.

  Related docs:
  - https://zod.dev/
*/

import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { ZodObject } from "zod";
import type { $ZodIssue as ZodIssue } from "zod/v4/core";

/* ************************************************************************ */
/* Types                                                                    */
/* ************************************************************************ */

/**
 * Multi-target validation schema options.
 */
export type ValidationTargets = {
  body?: ZodObject;
  query?: ZodObject;
  params?: ZodObject;
};

export type ValidatorOptions = {
  inject?: (request: FastifyRequest) => Record<string, unknown>;
};

/* ************************************************************************ */
/* createValidator                                                          */
/* ************************************************************************ */

/*
  createValidator(targets, options):
  - Accepts a multi-target object ({ body, query, params })
  - Replaces validated request targets with parsed (typed, sanitized) results
  - Returns 400 with detailed Zod issues on validation failure
  - Supports optional server-side injection into request.body via options.inject
*/
export const createValidator = (
  targets: ValidationTargets,
  options: ValidatorOptions = {},
): preHandlerAsyncHookHandler => {
  return async (request, reply) => {
    const issues: ZodIssue[] = [];

    if (targets.params) {
      const parsed = targets.params.safeParse(request.params);
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
      } else {
        request.params = parsed.data;
      }
    }

    if (targets.query) {
      const parsed = targets.query.safeParse(request.query);
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
      } else {
        request.query = parsed.data;
      }
    }

    if (targets.body) {
      const parsed = targets.body.safeParse(request.body);
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
      } else {
        const { inject } = options;

        if (inject) {
          request.body = { ...parsed.data, ...inject(request) };
        } else {
          request.body = parsed.data;
        }
      }
    }

    if (issues.length > 0) {
      reply.code(400).send(issues);
      return reply;
    }
  };
};

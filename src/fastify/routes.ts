/*
  Purpose:
  Central HTTP routing entry point for the Fastify API.

  Responsibilities:
  - Register global plugins and hooks (cookies, CSRF protection, multipart)
  - Expose a minimal health / sanity endpoint
  - Compose feature modules (auth, items, users)

  Design notes:
  - This file contains no business logic
  - Each feature lives in its own isolated plugin
  - Hook order is explicit and intentional
  - The whole tree is exported through fastify-plugin so that the cookie
    parsing and the CSRF hook apply to the entire application (including the
    SSR catch-all), exactly like `app.use(router)` did with Express

  Related docs:
  - https://fastify.dev/docs/latest/Reference/Routes/
  - https://fastify.dev/docs/latest/Reference/Plugins/
*/

/* ************************************************************************ */
/* Plugin initialization                                                    */
/* ************************************************************************ */

import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

import { csrf } from "./helpers/csrf";

/* ************************************************************************ */
/* API modules                                                              */
/* ************************************************************************ */

/*
  The order does not matter as long as routes do not conflict.
*/

import authRoutes from "./modules/auth/authRoutes";
import itemRoutes from "./modules/item/itemRoutes";
import userRoutes from "./modules/user/userRoutes";

const routes: FastifyPluginAsync = async (fastify) => {
  /* ********************************************************************** */
  /* Global plugins and hooks                                               */
  /* ********************************************************************** */

  /*
    Order matters:

    1. @fastify/cookie
       - Parses cookies into request.cookies
       - Adds reply.setCookie / reply.clearCookie
       - Required for authentication and CSRF validation

    2. @fastify/multipart
       - Adds the multipart/form-data content type parser
       - Required by the avatar uploader

    3. csrf()
       - Validates double-submit CSRF tokens on mutative requests
       - Stateless, cookie + header comparison only
       - Registered as an onRequest hook, so it runs *before* body parsing

    JSON body parsing is built into Fastify: no extra plugin is needed.

    The `await` calls guarantee the plugins are loaded before the CSRF hook is
    registered, so request.cookies is populated when the hook runs.
  */
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyMultipart);

  fastify.addHook("onRequest", csrf());

  /* ********************************************************************** */
  /* Base endpoint                                                          */
  /* ********************************************************************** */

  /*
    Minimal API sanity check.
    Useful for smoke tests and quick validation that the server is reachable.

    GET:
    - Returns a JSON payload to confirm the API is alive

    POST:
    - Echoes the request body to validate CSRF protection is working
    - Useful for front-end integration testing
  */
  fastify.get("/api/health", async () => ({ hello: "world" }));

  fastify.post("/api/health", async (request) => request.body ?? {});

  fastify.delete("/api/health", async (_request, reply) => {
    reply.code(204).send();
  });

  /* ********************************************************************** */
  /* API modules                                                            */
  /* ********************************************************************** */

  await fastify.register(authRoutes);
  await fastify.register(itemRoutes);
  await fastify.register(userRoutes);
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default fp(routes);

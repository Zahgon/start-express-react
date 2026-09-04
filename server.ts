/**
 * BEGINNERS: See the wiki page "One server" for a guided walkthrough.
 *
 * https://github.com/rocambille/start-express-react/wiki/One-server
 *
 * (en français ici:
 *
 * https://github.com/rocambille/start-express-react/wiki/Un-serveur-unique-fr-FR)
 *
 * NOTE: you don't need to understand or edit this file to build your app.
 *
 * Purpose:
 * Main application entry point.
 *
 * Responsibilities:
 * - Create and configure the Fastify server
 * - Mount API routes
 * - Integrate Vite for SSR in development
 * - Serve static assets in production
 *
 * Design notes:
 * - Single server for API + SSR
 * - Fully stateless backend
 * - No server-side sessions
 *
 * Related docs:
 * - https://fastify.dev/
 * - https://vitejs.dev/guide/ssr
 */

import { serverEnv } from "./src/env/server";

/* ************************************************************************ */
/*                                  Startup                                 */
/* ************************************************************************ */

const isProduction = serverEnv.NODE_ENV === "production";

const port = serverEnv.APP_PORT;

const indexHtml = readIndexHtml();

// Server creation is async because it may initialize Vite in dev mode
createServerWith("./src/fastify/routes").then(async (app) => {
  // Listening on "::" keeps the server reachable from outside a container,
  // which is what Express did by default.
  await app.listen({ port, host: "::" });

  console.info(`Listening on http://localhost:${port}`);
});

/* ************************************************************************ */
/*                             Server creation                              */
/* ************************************************************************ */

/**
 * Patch globalThis.fetch to support relative URLs during SSR.
 *
 * In Node.js:
 * - fetch("/api") throws "Absolute URL required"
 * - We need to resolve relative URLs against the request URL
 *
 * Solution:
 * - Create a storage that holds the base URL for the current request
 * - Patch fetch to resolve relative URLs against this base URL
 */
import { AsyncLocalStorage } from "node:async_hooks";

const fetchBaseStorage = new AsyncLocalStorage<{
  base: string;
  cookie?: string;
}>();

const nodeFetch = globalThis.fetch;

globalThis.fetch = (resource, init) => {
  const store = fetchBaseStorage.getStore();

  // 1. Resolve relative URLs against the request base URL
  const url = store?.base ? new URL(resource.toString(), store.base) : resource;

  // 2. Forward cookies for internal API calls (relative paths) during SSR
  // Security: Only forward for relative paths starting with "/" but not "//"
  // to avoid leaking cookies to external domains via protocol-relative URLs.
  const isInternal =
    typeof resource === "string" &&
    resource.startsWith("/") &&
    !resource.startsWith("//");

  if (isInternal && store?.cookie) {
    const headers = new Headers(init?.headers);
    if (!headers.has("cookie")) {
      headers.set("cookie", store.cookie);
    }
    return nodeFetch(url, { ...init, headers });
  }

  return nodeFetch(url, init);
};

/**
 * Fastify / Vite integration
 */
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { FastifyError } from "fastify";
import Fastify from "fastify";

export async function createServerWith(routesPath: string) {
  const app = Fastify();

  // Fastify owns the underlying Node HTTP server; Vite's HMR attaches to it.
  const httpServer = app.server;

  /* ********************************************************************** */
  /* Error handling                                                         */
  /* ********************************************************************** */

  /*
    Error handler:
    Logs errors for debugging, then sends a structured JSON response instead of
    Fastify's default payload. Stack traces are hidden in production to avoid
    leaking implementation details.

    It is registered first: every plugin encapsulation context created later
    inherits it.
  */
  app.setErrorHandler<FastifyError & { status?: number }>(
    (err, request, reply) => {
      console.error(err);
      console.error("on req:", request.method, request.url);

      const status = err.status ?? err.statusCode ?? 500;

      reply.code(status).send({
        message: err.message ?? "Internal Server Error",
        ...(isProduction ? {} : { stack: err.stack }),
      });
    },
  );

  /* ********************************************************************** */
  /* Helmet                                                                 */
  /* ********************************************************************** */

  // SECURITY:
  // Sets HTTP response headers such as Content-Security-Policy and
  // Strict-Transport-Security. See https://helmetjs.github.io/ for details.
  //
  // Content-Security-Policy is enabled only in production.
  // In development it is disabled because Vite's HMR relies on
  // WebSocket connections and dynamic module evaluation, which
  // are blocked by Helmet's default CSP.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: isProduction,
  });

  /* ********************************************************************** */
  /* Rate limiting                                                          */
  /* ********************************************************************** */

  // SECURITY:
  // Basic rate limiting to mitigate brute-force and abuse.
  // This is intentionally simple and should be tuned per deployment.
  if (isProduction) {
    await app.register(fastifyRateLimit, {
      timeWindow: 15 * 60 * 1000, // 15 minutes
      max: 100, // max 100 requests per window
    });
  }

  /* ********************************************************************** */
  /* Static file serving                                                    */
  /* ********************************************************************** */

  // @fastify/static requires an existing root directory.
  fs.mkdirSync("./data/uploads", { recursive: true });

  await app.register(fastifyStatic, {
    root: path.resolve("./data/uploads"),
    prefix: "/uploads/",
  });

  /* ********************************************************************** */
  /* API routes                                                             */
  /* ********************************************************************** */

  // All API routes are mounted here.
  // They are isolated, stateless, and independently testable.
  await app.register((await import(routesPath)).default);

  /* ********************************************************************** */
  /* Frontend / SSR configuration                                           */
  /* ********************************************************************** */

  const maybeVite = await configure(app, httpServer);

  /* ****************************************************************** */
  /* Load HTML template and SSR renderer                                */
  /* ****************************************************************** */

  const getTemplateAndRender = async (url: string) => {
    // Production mode:
    // SSR bundle is prebuilt and loaded from dist/
    if (maybeVite == null) {
      // NOTE:
      // This file does not exist before the build step.
      // @ts-expect-error - runtime-only import
      const { render } = await import("./dist/server/entry-server");

      return { template: indexHtml, render };
    }

    // Development mode:
    // Vite handles on-the-fly module loading and HMR
    const vite = maybeVite;

    // 1. Apply Vite HTML transforms (HMR client, plugin hooks, etc.)
    const template = await vite.transformIndexHtml(url, indexHtml);

    // 2. Load the SSR entry module via Vite
    const { render } = await vite.ssrLoadModule("/src/entry-server");

    return { template, render };
  };

  // Catch-all handler for SSR:
  // every request that did not match an API route nor a static asset.
  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url;
    const base = `http://localhost:${port}${url}`;
    const cookie = request.headers.cookie;

    return fetchBaseStorage.run({ base, cookie }, async () => {
      try {
        // Prevent caching of the HTML page
        // SSR is auth-aware and must not be cached
        reply.header("Cache-Control", "private, no-store");

        /* **************************************************************** */
        /* Render application                                               */
        /* **************************************************************** */

        const { template, render } = await getTemplateAndRender(url);

        // The render function is responsible for:
        // - Rendering the React app
        // - Injecting HTML into the template
        // - Sending the response
        await render(template, request, reply);

        return reply;
      } catch (err) {
        // DEV EXPERIENCE:
        // Let Vite rewrite stack traces so they map to source files.
        if (err instanceof Error) maybeVite?.ssrFixStacktrace(err);
        throw err;
      }
    });
  });

  return app;
}

/* ************************************************************************ */
/*                              Helper utils                                */
/* ************************************************************************ */

/**
 * Reads the HTML template depending on the environment.
 *
 * - Development: unbuilt index.html
 * - Production: generated dist/client/index.html
 */
import fs from "node:fs";
import path from "node:path";

function readIndexHtml() {
  return fs.readFileSync(
    isProduction ? "dist/client/index.html" : "index.html",
    "utf-8",
  );
}

/**
 * Configure frontend serving depending on environment.
 *
 * - Production:
 *   - Enable compression
 *   - Serve static assets
 *
 * - Development:
 *   - Create a Vite dev server in middleware mode
 *   - Let Fastify control routing
 */
import type http from "node:http";
import fastifyCompress from "@fastify/compress";
import fastifyMiddie from "@fastify/middie";
import type { FastifyInstance } from "fastify";
import { createServer as createViteServer } from "vite";

async function configure(app: FastifyInstance, httpServer: http.Server) {
  if (isProduction) {
    await app.register(fastifyCompress);
    await app.register(fastifyStatic, {
      root: path.resolve("./dist/client"),
      decorateReply: false,
    });
  } else {
    // Create Vite server in middleware mode.
    // Fastify remains the main HTTP server.
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: "custom",
    });

    // @fastify/middie brings Connect-style middleware support to Fastify,
    // which is exactly what vite.middlewares is.
    //
    // NOTE:
    // vite.middlewares remains stable across restarts,
    // even if Vite internally reloads plugins or config.
    await app.register(fastifyMiddie);
    app.use(vite.middlewares);

    return vite;
  }
}

/*
  Purpose:
  Server-side rendering entry point for the React application.

  Responsibilities:
  - Execute React Router loaders and actions on the server
  - Resolve routing context for the incoming request
  - Render the React tree to an HTML stream
  - Inject the rendered output into the HTML template

  Design notes:
  - This file runs only in Node.js
  - It does not serve HTTP directly; Fastify owns the response lifecycle
  - It remains fully stateless: no session, no global request data

  Related docs:
  - https://reactrouter.com/start/data/custom#server-rendering
  - https://react.dev/reference/react-dom/server/renderToPipeableStream
*/

import { PassThrough, Readable, Transform } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import { StrictMode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";

import routes from "./react/routes";

/* ************************************************************************ */
/*                           Static routing setup                           */
/* ************************************************************************ */

/*
  createStaticHandler prepares:
  - `query`: executes loaders and actions for a given request
  - `dataRoutes`: normalized route definitions for static routing

  This step is done once at module load time.
*/
const { query, dataRoutes } = createStaticHandler(routes);

/* ************************************************************************ */
/*                             SSR render entry                             */
/* ************************************************************************ */

export const render = async (
  template: string,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  /* ********************************************************************** */
  /* 1. Resolve routing context (loaders + actions)                         */
  /* ********************************************************************** */

  /*
    The request passed to React Router must be a WHATWG Request,
    not a Fastify request.

    The URL must be absolute for loaders relying on fetch().
  */
  const whatwgRequest = new Request(
    `${request.protocol}://${request.host}${request.url}`,
  );
  // Forward headers (including cookies)
  for (const [key, value] of Object.entries(request.headers)) {
    if (value != null) {
      whatwgRequest.headers.set(
        key,
        Array.isArray(value) ? value.join(", ") : String(value),
      );
    }
  }
  const context = await query(whatwgRequest);

  /* ********************************************************************** */
  /* Early response handling                                                */
  /* ********************************************************************** */

  /*
    Loaders and actions may return a Response directly:
    - redirects
    - error responses
    - short-circuited flows

    In that case, forward it as-is to Fastify.
  */
  if (context instanceof Response) {
    for (const [key, value] of context.headers.entries()) {
      reply.header(key, value);
    }

    return reply
      .code(context.status)
      .send(
        context.body == null
          ? undefined
          : Readable.fromWeb(context.body as ReadableStream),
      );
  }

  /* ********************************************************************** */
  /* Header propagation                                                     */
  /* ********************************************************************** */

  /*
    React Router allows loaders and actions to attach headers.

    Only headers from the deepest matched route are applied,
    mirroring browser behavior.
  */
  const leaf = context.matches[context.matches.length - 1];

  if (leaf) {
    const actionHeaders = context.actionHeaders[leaf.route.id];
    if (actionHeaders) {
      for (const [key, value] of actionHeaders.entries()) {
        reply.header(key, value);
      }
    }

    const loaderHeaders = context.loaderHeaders[leaf.route.id];
    if (loaderHeaders) {
      for (const [key, value] of loaderHeaders.entries()) {
        reply.header(key, value);
      }
    }
  }

  /* ********************************************************************** */
  /* 2. Static router creation                                              */
  /* ********************************************************************** */

  /*
    The static router binds:
    - resolved route matches
    - loader data
    - errors

    It is later rehydrated on the client using the same data.
  */
  const router = createStaticRouter(dataRoutes, context);

  /* ********************************************************************** */
  /* 3. React SSR streaming                                                 */
  /* ********************************************************************** */

  /*
    renderToPipeableStream enables:
    - streaming HTML to the client
    - reduced TTFB
    - progressive rendering

    StrictMode helps surface unsafe patterns early.
  */
  const { pipe } = renderToPipeableStream(
    <StrictMode>
      <StaticRouterProvider router={router} context={context} />
    </StrictMode>,
  );

  /* ********************************************************************** */
  /* 4. HTML template injection                                             */
  /* ********************************************************************** */

  /*
    The template is split around <!--ssr-outlet-->.
    React output is streamed between the two parts.

    Fastify sends streams natively: handing it a PassThrough keeps the
    response streaming while preserving the onSend hooks (compression,
    security headers, ...).
  */
  const responseStream = new PassThrough();

  reply
    .code(context.statusCode ?? 200)
    .header("Content-Type", "text/html; charset=utf-8")
    .send(responseStream);

  const [htmlStart, htmlEnd] = template.split("<!--ssr-outlet-->");

  responseStream.write(htmlStart);

  const transformStream = new Transform({
    transform(chunk, encoding, callback) {
      responseStream.write(chunk, encoding);
      callback();
    },
  });

  pipe(transformStream);

  transformStream.on("finish", () => {
    responseStream.end(htmlEnd);
  });
};

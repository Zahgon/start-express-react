/*
  Purpose:
  Define HTTP request handlers for Item-related operations.

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
import itemRepository from "./itemRepository";
import type { ItemDTOWithUserId } from "./itemSchemas";

/* ************************************************************************ */
/* Handlers                                                                 */
/* ************************************************************************ */

/*
  Browse items by range.

  Preconditions:
  - None (public endpoint)
  - A valid `Range: items=start-end` header must be present

  Response:
  - 206 Partial Content with Content-Range header and the requested slice
  - 400 if no Range header or format is invalid
  - 416 Range Not Satisfiable if start >= total
*/
const browse: RouteHandler = async (request, reply) => {
  // This handler implements HTTP range semantics (single range only).
  // See https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests

  reply.header("Accept-Ranges", "items");

  // Parse the Range header
  // Example: "Range: items=0-9"

  const match = request.headers.range?.match(/^items=(\d+)-(\d+)$/);

  if (!match) {
    reply.code(400).send();
    return;
  }

  const [start, end] = [Number(match[1]), Number(match[2])];

  // Check if the range is valid

  const total = itemRepository.count();

  if (start < 0 || start > end || start >= total) {
    reply.header("Content-Range", `items */${total}`);
    reply.code(416).send();

    return;
  }

  // Fetch items for the specified range

  const limit = end - start + 1;
  const items = itemRepository.findAll(limit, start);

  // Set the Content-Range header and send the range of items (206)

  reply.header(
    "Content-Range",
    `items ${start}-${Math.min(end, total - 1)}/${total}`,
  );
  reply.code(206).send(items);
};

/* ************************************************************************ */

/*
  Read a single item.

  Preconditions:
  - `request.item` has been injected by the param converter

  Response:
  - 200 with the item payload
*/
const read: RouteHandler = async (request, reply) => {
  reply.send(request.item);
};

/* ************************************************************************ */

/*
  Edit an existing item.

  Preconditions:
  - User is authenticated
  - User is authorized to access this item
  - request.body has been validated and sanitized

  Response:
  - 204 No Content on success
*/
const edit: RouteHandler<{ Body: Item }> = async (request, reply) => {
  itemRepository.update(request.body);

  reply.code(204).send();
};

/* ************************************************************************ */

/*
  Create a new item.

  Preconditions:
  - User is authenticated
  - request.body has been validated and enriched with user_id

  Response:
  - 201 Created with the new item's id
*/
const add: RouteHandler<{ Body: ItemDTOWithUserId }> = async (
  request,
  reply,
) => {
  const insertId = itemRepository.create(request.body);

  reply.code(201).send({ insertId });
};

/* ************************************************************************ */

/*
  Soft-delete an item.

  Preconditions:
  - User is authenticated
  - User is authorized to access this item

  Response:
  - 204 No Content
*/
const destroy: RouteHandler = async (request, reply) => {
  itemRepository.softDelete(request.item.id);

  reply.code(204).send();
};

/* ************************************************************************ */
/* Export                                                                   */
/* ************************************************************************ */

export default {
  browse,
  read,
  edit,
  add,
  destroy,
};

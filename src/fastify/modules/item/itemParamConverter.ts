/*
  Purpose:
  Convert the `:itemId` route parameter into a fully loaded Item.

  This module:
  - Centralizes item lookup logic
  - Attaches the resolved item to the request object
  - Stops the request early if the item does not exist

  Why this exists:
  - Avoids duplicated lookup code in controllers
  - Guarantees `request.item` for downstream handlers
  - Keeps route handlers small and predictable

  Related docs:
  - https://fastify.dev/docs/latest/Reference/Hooks/#prehandler
*/

/*
  Extend FastifyRequest to include `item`.

  After this preHandler runs successfully:
  - `request.item` is always defined
  - Controllers and guards can rely on it without null checks
*/
declare module "fastify" {
  interface FastifyRequest {
    item: Item;
  }
}

/*
  Export converter
*/
import { createParamConverter } from "../../helpers/paramConverter";
import itemRepository from "./itemRepository";

export default createParamConverter(itemRepository, "item");

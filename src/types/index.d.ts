declare module "*.css";

type Json = string | number | bigint | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: Json };
type JsonArray = Json[];

type Item = import("../fastify/modules/item/itemSchemas").Item;
type User = import("../fastify/modules/user/userSchemas").User;

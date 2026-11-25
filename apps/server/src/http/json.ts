import type { z } from "zod";
import { badRequest, parseWith } from "./errors";

/**
 * A JSON text validated with a shared schema: the body of an API request, or
 * the body that the operator command (`cli settings apply`) reads from stdin.
 */
export function parseJsonBody<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("The request body must be JSON");
  }
  return parseWith(schema, body);
}

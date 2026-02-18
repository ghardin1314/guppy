/**
 * Nano ID generator. URL-safe, 21 chars by default.
 *
 * Uses crypto.getRandomValues for secure randomness,
 * wrapped in Effect.sync for testability.
 */

import { Effect } from "effect";

const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";

const DEFAULT_SIZE = 21;

export const nanoid = (size: number = DEFAULT_SIZE): Effect.Effect<string> =>
  Effect.sync(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    let id = "";
    for (let i = 0; i < size; i++) {
      id += alphabet[bytes[i]! & 63];
    }
    return id;
  });

import { expect } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { it } from "./test.ts";
import { makeDbLayer } from "./db.ts";

const DbTest = makeDbLayer(":memory:");

it.layer(DbTest)("db", (it) => {
  it.effect("creates tables and sets schema version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE '_guppy_%'
        ORDER BY name
      `;

      expect(tables.map((t) => t.name)).toEqual([
        "_guppy_events",
        "_guppy_messages",
        "_guppy_migrations",
        "_guppy_threads",
      ]);
    })
  );

  it.effect("tracks applied migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ migrationId: number; name: string }>`
        SELECT migration_id, name FROM _guppy_migrations ORDER BY migration_id
      `;

      expect(rows).toEqual([
        { migrationId: 1, name: "initial" },
      ]);
    })
  );

  it.effect("migration is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE '_guppy_%'
        ORDER BY name
      `;

      expect(tables.map((t) => t.name)).toEqual([
        "_guppy_events",
        "_guppy_messages",
        "_guppy_migrations",
        "_guppy_threads",
      ]);
    })
  );
});

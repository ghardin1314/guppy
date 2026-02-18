/**
 * Database layer for guppy.
 *
 * Uses @effect/sql-sqlite-bun for the SqliteClient and @effect/sql's
 * Migrator for schema versioning. Migrations are imported directly
 * and loaded via Migrator.fromRecord.
 */

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Migrator } from "@effect/sql";
import { BunContext } from "@effect/platform-bun";
import { Layer, String as Str } from "effect";

import migration0001 from "./migrations/0001_initial.ts";

const migrations = Migrator.fromRecord({
  "0001_initial": migration0001,
});

const MigrationLayer = SqliteMigrator.layer({
  loader: migrations,
  table: "_guppy_migrations",
}).pipe(Layer.provide(BunContext.layer));

// -- Layer --------------------------------------------------------------------

/**
 * Create the database layer for a given project directory.
 *
 * Provides SqliteClient and SqlClient tags. Runs schema migrations
 * eagerly so downstream services can assume tables exist.
 */
export const makeDbLayer = (dbPath: string) => {
  const ClientLayer = SqliteClient.layer({
    filename: dbPath,
    transformResultNames: Str.snakeToCamel,
    transformQueryNames: Str.camelToSnake,
  });

  return Layer.provideMerge(MigrationLayer, ClientLayer);
};

/**
 * Persistence layer for event schedules.
 */

import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import { nanoid } from "./id.ts";
import type { EventSchedule, ScheduleStatus } from "./schema.ts";

// -- Service interface --------------------------------------------------------

export interface ScheduleStoreService {
  readonly insertSchedule: (params: {
    eventType: string;
    eventData: string;
    scheduleType: "delayed" | "cron";
    scheduledAt: number | null;
    cronExpression: string | null;
  }) => Effect.Effect<EventSchedule, SqlError.SqlError>;

  readonly setScheduleStatus: (
    id: string,
    status: ScheduleStatus,
  ) => Effect.Effect<void, SqlError.SqlError>;

  readonly setScheduleLastFired: (
    id: string,
    lastFiredAt: number,
  ) => Effect.Effect<void, SqlError.SqlError>;

  readonly getPendingSchedules: (
    scheduleType: "delayed" | "cron",
  ) => Effect.Effect<ReadonlyArray<EventSchedule>, SqlError.SqlError>;
}

// -- Tag ----------------------------------------------------------------------

export class ScheduleStore extends Context.Tag("@guppy/core/ScheduleStore")<
  ScheduleStore,
  ScheduleStoreService
>() {
  static layer = Layer.effect(
    ScheduleStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return ScheduleStore.of({
        insertSchedule: (params) =>
          Effect.gen(function* () {
            const id = yield* nanoid();
            const ts = yield* Clock.currentTimeMillis;
            yield* sql`
              INSERT INTO _guppy_schedules
                (id, event_type, event_data, schedule_type, status, scheduled_at, cron_expression, created_at)
              VALUES
                (${id}, ${params.eventType}, ${params.eventData}, ${params.scheduleType}, 'pending', ${params.scheduledAt}, ${params.cronExpression}, ${ts})
            `;
            return {
              id,
              eventType: params.eventType,
              eventData: params.eventData,
              scheduleType: params.scheduleType,
              status: "pending" as const,
              scheduledAt: params.scheduledAt,
              cronExpression: params.cronExpression,
              lastFiredAt: null,
              createdAt: ts,
            };
          }),

        setScheduleStatus: (id, status) =>
          sql`
            UPDATE _guppy_schedules SET status = ${status} WHERE id = ${id}
          `.pipe(Effect.asVoid),

        setScheduleLastFired: (id, lastFiredAt) =>
          sql`
            UPDATE _guppy_schedules SET last_fired_at = ${lastFiredAt} WHERE id = ${id}
          `.pipe(Effect.asVoid),

        getPendingSchedules: (scheduleType) =>
          sql<EventSchedule>`
            SELECT * FROM _guppy_schedules
            WHERE schedule_type = ${scheduleType} AND status = 'pending'
          `,
      });
    }),
  );
}

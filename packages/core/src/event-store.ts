/**
 * Persistence layer for schedules and deliveries.
 */

import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient, SqlError } from "@effect/sql";
import type {
  EventSchedule,
  ScheduleStatus,
  EventDelivery,
} from "./schema.ts";
import { nanoid } from "./id.ts";

// -- Service interface --------------------------------------------------------

export interface EventStoreService {
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

  readonly insertDelivery: (params: {
    scheduleId: string | null;
    subscriberId: string;
    eventType: string;
    eventData: string;
  }) => Effect.Effect<EventDelivery, SqlError.SqlError>;

  readonly updateDelivery: (
    delivery: EventDelivery,
  ) => Effect.Effect<void, SqlError.SqlError>;

  readonly getDelivery: (
    deliveryId: string,
  ) => Effect.Effect<EventDelivery | null, SqlError.SqlError>;

  readonly getDeliveries: (
    subscriberId?: string,
  ) => Effect.Effect<ReadonlyArray<EventDelivery>, SqlError.SqlError>;
}

// -- Tag ----------------------------------------------------------------------

export class EventStore extends Context.Tag("@guppy/core/EventStore")<
  EventStore,
  EventStoreService
>() {}

// -- Live implementation ------------------------------------------------------

export const EventStoreLive = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return EventStore.of({
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

      insertDelivery: (params) =>
        Effect.gen(function* () {
          const id = yield* nanoid();
          const ts = yield* Clock.currentTimeMillis;
          yield* sql`
            INSERT INTO _guppy_deliveries
              (id, schedule_id, subscriber_id, event_type, event_data, status, retry_count, max_retries, created_at)
            VALUES
              (${id}, ${params.scheduleId}, ${params.subscriberId}, ${params.eventType}, ${params.eventData}, 'pending', 0, 3, ${ts})
          `;
          return {
            id,
            scheduleId: params.scheduleId,
            subscriberId: params.subscriberId,
            eventType: params.eventType,
            eventData: params.eventData,
            status: "pending" as const,
            retryCount: 0,
            maxRetries: 3,
            lastError: null,
            createdAt: ts,
            deliveredAt: null,
          };
        }),

      updateDelivery: (delivery) =>
        sql`
          UPDATE _guppy_deliveries
          SET status = ${delivery.status},
              retry_count = ${delivery.retryCount},
              last_error = ${delivery.lastError},
              delivered_at = ${delivery.deliveredAt}
          WHERE id = ${delivery.id}
        `.pipe(Effect.asVoid),

      getDelivery: (deliveryId) =>
        Effect.gen(function* () {
          const rows = yield* sql<EventDelivery>`
            SELECT * FROM _guppy_deliveries WHERE id = ${deliveryId}
          `;
          return rows[0] ?? null;
        }),

      getDeliveries: (subscriberId) =>
        subscriberId
          ? sql<EventDelivery>`
              SELECT * FROM _guppy_deliveries
              WHERE subscriber_id = ${subscriberId}
              ORDER BY created_at DESC
            `
          : sql<EventDelivery>`
              SELECT * FROM _guppy_deliveries ORDER BY created_at DESC
            `,
    });
  }),
);

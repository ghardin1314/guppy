/**
 * Event bus: general-purpose pub/sub with scheduling.
 *
 * Subscribers register with a glob pattern that matches against the event's
 * `type` field. Events are any JSON-serializable object with a `type` string.
 * Publishers and subscribers are responsible for the shape of their own events.
 *
 * Scheduling is orthogonal to event type — any BusEvent can be scheduled
 * for delayed or cron-based emission.
 */

import { SqlError } from "@effect/sql";
import {
  Clock,
  Context,
  Cron,
  DateTime,
  Duration,
  Effect,
  Either,
  FiberMap,
  Layer,
  Schema,
} from "effect";
import type { ParseError } from "effect/ParseResult";
import { ScheduleStore } from "./event-store.ts";
import type { BusEvent, EventSchedule, ScheduleTiming } from "./schema.ts";

// -- Pattern matching ---------------------------------------------------------

function matchPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === eventType;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = "^" + escaped.replace(/\*/g, "[^.]*") + "$";
  return new RegExp(re).test(eventType);
}

// -- Handler type -------------------------------------------------------------

type EventHandler = (event: BusEvent) => Effect.Effect<void, unknown>;

const decodeEvent = Schema.decode(Schema.parseJson()) as (
  eventData: string,
) => Effect.Effect<BusEvent, ParseError>;

const encodeEvent = Schema.encode(Schema.parseJson()) as (
  event: BusEvent,
) => Effect.Effect<string, ParseError>;

// -- Subscriber record --------------------------------------------------------

interface Subscriber {
  readonly pattern: string;
  readonly handler: EventHandler;
}

// -- Service interface --------------------------------------------------------

export interface EventBusService {
  readonly emit: (event: BusEvent) => Effect.Effect<void>;

  readonly schedule: (
    event: BusEvent,
    timing: ScheduleTiming,
  ) => Effect.Effect<
    EventSchedule,
    SqlError.SqlError | Cron.ParseError | ParseError
  >;

  readonly cancel: (
    scheduleId: string,
  ) => Effect.Effect<void, SqlError.SqlError>;

  readonly subscribe: (
    subscriberId: string,
    pattern: string,
    handler: EventHandler,
  ) => Effect.Effect<void>;

  readonly unsubscribe: (subscriberId: string) => Effect.Effect<void>;
}

// -- Tag ----------------------------------------------------------------------

export class EventBus extends Context.Tag("@guppy/core/EventBus")<
  EventBus,
  EventBusService
>() {
  static layer = Layer.scoped(
    EventBus,
    Effect.gen(function* () {
      const store = yield* ScheduleStore;
      const scope = yield* Effect.scope;
      const subscribers = new Map<string, Subscriber>();
      const fibers = yield* FiberMap.make<string>();

      // -- Internal helpers ---------------------------------------------------

      const deliverToSubscribers = (event: BusEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const matching = Array.from(subscribers.entries()).filter(([, sub]) =>
            matchPattern(sub.pattern, event.type),
          );

          for (const [, sub] of matching) {
            yield* sub.handler(event).pipe(Effect.ignore);
          }
        });

      const forkDelayedFiber = (schedule: EventSchedule) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const delay = schedule.scheduledAt! - now;
              if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
              const event = yield* decodeEvent(schedule.eventData);
              yield* deliverToSubscribers(event);
              yield* store.setScheduleStatus(schedule.id, "fired");
            }).pipe(Effect.ignore),
            scope,
          );
          yield* FiberMap.set(fibers, schedule.id, fiber);
        });

      const forkCronFiber = (schedule: EventSchedule) =>
        Effect.gen(function* () {
          const cron = Cron.unsafeParse(schedule.cronExpression!);
          const fiber = yield* Effect.forkIn(
            Effect.iterate(schedule.lastFiredAt, {
              while: () => true,
              body: (lastFired) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  const from =
                    lastFired != null ? new Date(lastFired) : new Date(now);
                  const next = Cron.next(cron, from);
                  const delay = next.getTime() - now;
                  if (delay > 0) yield* Effect.sleep(Duration.millis(delay));

                  yield* decodeEvent(schedule.eventData).pipe(
                    Effect.flatMap(deliverToSubscribers),
                    Effect.ignore,
                  );

                  const ts = yield* Clock.currentTimeMillis;
                  yield* store
                    .setScheduleLastFired(schedule.id, ts)
                    .pipe(Effect.ignore);
                  return ts;
                }),
            }),
            scope,
          );
          yield* FiberMap.set(fibers, schedule.id, fiber);
        });

      // -- Service implementation -----------------------------------------------

      const service = EventBus.of({
        emit: (event) => deliverToSubscribers(event),

        schedule: (event, timing) =>
          Effect.gen(function* () {
            if (timing.type === "cron") {
              const parsed = Cron.parse(timing.cronExpression);
              if (Either.isLeft(parsed)) {
                return yield* Effect.fail(parsed.left);
              }
            }

            const scheduledAtMs =
              timing.type === "delayed"
                ? DateTime.toEpochMillis(timing.scheduledAt)
                : null;

            const eventData = yield* encodeEvent(event);

            const schedule = yield* store.insertSchedule({
              eventType: event.type,
              eventData,
              scheduleType: timing.type === "cron" ? "cron" : "delayed",
              scheduledAt: scheduledAtMs,
              cronExpression:
                timing.type === "cron" ? timing.cronExpression : null,
            });

            if (timing.type === "cron") {
              yield* forkCronFiber(schedule);
            } else {
              yield* forkDelayedFiber(schedule);
            }

            return schedule;
          }),

        cancel: (scheduleId) =>
          Effect.gen(function* () {
            yield* FiberMap.remove(fibers, scheduleId);
            yield* store.setScheduleStatus(scheduleId, "canceled");
          }),

        subscribe: (subscriberId, pattern, handler) =>
          Effect.sync(() => {
            subscribers.set(subscriberId, { pattern, handler });
          }),

        unsubscribe: (subscriberId) =>
          Effect.sync(() => {
            subscribers.delete(subscriberId);
          }),
      });

      // -- Boot recovery: load persisted schedules into memory -----------------

      const delayed = yield* store.getPendingSchedules("delayed");
      for (const s of delayed) {
        yield* forkDelayedFiber(s);
      }

      const crons = yield* store.getPendingSchedules("cron");
      for (const s of crons) {
        yield* forkCronFiber(s);
      }

      return service;
    }),
  ).pipe(Layer.provide(ScheduleStore.layer));
}

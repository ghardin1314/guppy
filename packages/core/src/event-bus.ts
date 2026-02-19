/**
 * Event bus: general-purpose pub/sub with scheduling and delivery guarantees.
 *
 * Subscribers register with a glob pattern that matches against the event's
 * `type` field. Each matching subscriber gets an independent delivery with
 * its own retry/dead-letter tracking.
 *
 * Scheduling is orthogonal to event type — any GuppyEvent variant can be
 * scheduled for delayed or cron-based emission.
 */

import { SqlError } from "@effect/sql";
import {
  Cause,
  Clock,
  Context,
  Cron,
  DateTime,
  Duration,
  Effect,
  Either,
  Exit,
  FiberMap,
  Layer,
  Ref,
  Schema,
} from "effect";
import type { ParseError } from "effect/ParseResult";
import { parseJson } from "effect/Schema";
import { EventStore } from "./event-store.ts";
import {
  EventDelivery,
  EventSchedule,
  GuppyEvent,
  ScheduleTiming,
} from "./schema.ts";
// -- Pattern matching ---------------------------------------------------------

function matchPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === eventType;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = "^" + escaped.replace(/\*/g, "[^.]*") + "$";
  return new RegExp(re).test(eventType);
}

// -- Handler type -------------------------------------------------------------

type EventHandler = (event: GuppyEvent) => Effect.Effect<void, unknown>;

// -- Subscriber record --------------------------------------------------------

interface Subscriber {
  readonly pattern: string;
  readonly handler: EventHandler;
}

// -- Service interface --------------------------------------------------------

export interface EventBusService {
  readonly emit: (
    event: GuppyEvent,
  ) => Effect.Effect<
    ReadonlyArray<EventDelivery>,
    SqlError.SqlError | ParseError
  >;

  readonly schedule: (
    event: GuppyEvent,
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

  readonly getDeliveries: (
    subscriberId?: string,
  ) => Effect.Effect<
    ReadonlyArray<EventDelivery>,
    SqlError.SqlError | ParseError
  >;

  readonly replayDeadLetter: (
    deliveryId: string,
  ) => Effect.Effect<EventDelivery, SqlError.SqlError | ParseError>;
}

// -- Tag ----------------------------------------------------------------------

export class EventBus extends Context.Tag("@guppy/core/EventBus")<
  EventBus,
  EventBusService
>() {}

// -- Live implementation ------------------------------------------------------

export const EventBusLive = Layer.scoped(
  EventBus,
  Effect.gen(function* () {
    const store = yield* EventStore;
    const scope = yield* Effect.scope;
    const subscribers = new Map<string, Subscriber>();
    const fibers = yield* FiberMap.make<string>();

    // Scheduled fibers are forked into the layer scope (not FiberMap's scope)
    // so they inherit the correct Clock implementation (needed for TestClock).
    // FiberMap tracks them by schedule ID for cancellation.

    // -- Internal helpers ---------------------------------------------------

    const attemptDelivery = (
      delivery: EventDelivery,
      handler: EventHandler,
      event: GuppyEvent,
    ): Effect.Effect<EventDelivery, SqlError.SqlError> =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);

        const exit = yield* handler(event).pipe(
          Effect.tapError((err) =>
            Effect.gen(function* () {
              const n = yield* Ref.updateAndGet(attempts, (a) => a + 1);
              yield* store.updateDelivery({
                ...delivery,
                retryCount: n,
                lastError: String(err),
              });
            }),
          ),
          Effect.retry({ times: delivery.maxRetries - 1 }),
          Effect.exit,
        );

        const retryCount = yield* Ref.get(attempts);

        if (Exit.isSuccess(exit)) {
          const ts = yield* Clock.currentTimeMillis;
          const delivered = {
            ...delivery,
            status: "delivered" as const,
            deliveredAt: ts,
            retryCount,
          };
          yield* store.updateDelivery(delivered);
          return delivered;
        }

        const deadLetter = {
          ...delivery,
          status: "dead_letter" as const,
          retryCount,
          lastError: String(Cause.squash(exit.cause)),
        };
        yield* store.updateDelivery(deadLetter);
        return deadLetter;
      });

    const deliverToSubscribers = (
      event: GuppyEvent,
      scheduleId: string | null,
    ): Effect.Effect<
      ReadonlyArray<EventDelivery>,
      SqlError.SqlError | ParseError
    > =>
      Effect.gen(function* () {
        const eventData = yield* Schema.encode(parseJson(GuppyEvent))(event);
        const matching = Array.from(subscribers.entries()).filter(([, sub]) =>
          matchPattern(sub.pattern, event.type),
        );

        if (matching.length === 0) return [];

        const results: EventDelivery[] = [];
        for (const [subscriberId, sub] of matching) {
          const delivery = yield* store.insertDelivery({
            scheduleId,
            subscriberId,
            eventType: event.type,
            eventData,
          });
          const result = yield* attemptDelivery(delivery, sub.handler, event);
          results.push(result);
        }
        return results;
      });

    const decodeEvent = (eventData: string) =>
      Schema.decode(parseJson(GuppyEvent))(eventData);

    const forkDelayedFiber = (schedule: EventSchedule) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const delay = schedule.scheduledAt! - now;
            if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
            const event = yield* decodeEvent(schedule.eventData);
            yield* deliverToSubscribers(event, schedule.id);
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
                  Effect.flatMap((event) =>
                    deliverToSubscribers(event, schedule.id),
                  ),
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
      emit: (event) => deliverToSubscribers(event, null),

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

          const eventData = yield* Schema.encode(parseJson(GuppyEvent))(event);

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

      getDeliveries: (subscriberId) => store.getDeliveries(subscriberId),

      replayDeadLetter: (deliveryId) =>
        Effect.gen(function* () {
          const existing = yield* store.getDelivery(deliveryId);
          const sub = subscribers.get(existing!.subscriberId);
          const event = yield* Schema.decode(parseJson(GuppyEvent))(
            existing!.eventData,
          );

          const reset = {
            ...existing!,
            status: "pending" as const,
            lastError: null,
          };
          yield* store.updateDelivery(reset);

          if (!sub) {
            const failed = {
              ...reset,
              status: "failed" as const,
              lastError: "no subscriber",
            };
            yield* store.updateDelivery(failed);
            return failed;
          }

          return yield* attemptDelivery(reset, sub.handler, event);
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
);

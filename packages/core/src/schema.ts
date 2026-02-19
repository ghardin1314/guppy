import { Schema } from "effect";

// -- Events -------------------------------------------------------------------

export const AgentMessageEvent = Schema.Struct({
  type: Schema.Literal("agent.message"),
  targetThreadId: Schema.String,
  sourceThreadId: Schema.NullOr(Schema.String),
  payload: Schema.String,
});
export type AgentMessageEvent = Schema.Schema.Type<typeof AgentMessageEvent>;

export const GuppyEvent = Schema.Union(AgentMessageEvent);
export type GuppyEvent = Schema.Schema.Type<typeof GuppyEvent>;

// -- Schedule Timing ----------------------------------------------------------

const ScheduleType = Schema.Literal("delayed", "cron");

export const DelayedScheduleTiming = Schema.Struct({
  type: ScheduleType.pipe(Schema.pickLiteral("delayed")),
  /** ISO 8601 datetime with timezone, e.g. "2026-02-19T09:00:00-05:00" */
  scheduledAt: Schema.DateTimeZoned,
});
export type DelayedScheduleTiming = Schema.Schema.Type<
  typeof DelayedScheduleTiming
>;

export const CronScheduleTiming = Schema.Struct({
  type: ScheduleType.pipe(Schema.pickLiteral("cron")),
  /** Standard 5-field cron expression, e.g. "0 9 * * MON" (every Monday 9AM) */
  cronExpression: Schema.String,
});
export type CronScheduleTiming = Schema.Schema.Type<typeof CronScheduleTiming>;

export const ScheduleTiming = Schema.Union(
  DelayedScheduleTiming,
  CronScheduleTiming,
);
export type ScheduleTiming = Schema.Schema.Type<typeof ScheduleTiming>;

// -- Event Schedule (persistence) ---------------------------------------------

export const ScheduleStatus = Schema.Literal("pending", "fired", "canceled");
export type ScheduleStatus = Schema.Schema.Type<typeof ScheduleStatus>;

export const EventSchedule = Schema.Struct({
  id: Schema.String,
  eventType: Schema.String,
  eventData: Schema.String,
  scheduleType: ScheduleType,
  status: ScheduleStatus,
  scheduledAt: Schema.NullOr(Schema.Number),
  cronExpression: Schema.NullOr(Schema.String),
  lastFiredAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
});
export type EventSchedule = Schema.Schema.Type<typeof EventSchedule>;

// -- Event Delivery (persistence) ---------------------------------------------

export const DeliveryStatus = Schema.Literal(
  "pending",
  "delivered",
  "failed",
  "dead_letter",
);
export type DeliveryStatus = Schema.Schema.Type<typeof DeliveryStatus>;

export const EventDelivery = Schema.Struct({
  id: Schema.String,
  scheduleId: Schema.NullOr(Schema.String),
  subscriberId: Schema.String,
  eventType: Schema.String,
  eventData: Schema.String,
  status: DeliveryStatus,
  retryCount: Schema.Number,
  maxRetries: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  deliveredAt: Schema.NullOr(Schema.Number),
});
export type EventDelivery = Schema.Schema.Type<typeof EventDelivery>;

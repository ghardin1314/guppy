import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { Schema } from "effect";
import { parseJson } from "effect/Schema";

// -- Branded identifiers ------------------------------------------------------

/** Transport name (e.g. "web", "cli"). */
export const TransportId = Schema.String.pipe(Schema.brand("TransportId"));
export type TransportId = Schema.Schema.Type<typeof TransportId>;

/** Globally unique thread identifier. */
export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = Schema.Schema.Type<typeof ThreadId>;

// -- Threads ------------------------------------------------------------------

export const ThreadStatus = Schema.Literal("idle", "active");
export type ThreadStatus = Schema.Schema.Type<typeof ThreadStatus>;

export const Thread = Schema.Struct({
  threadId: ThreadId,
  transport: TransportId,
  status: ThreadStatus,
  createdAt: Schema.Number,
  lastActiveAt: Schema.Number,
  leafId: Schema.String.pipe(Schema.NullOr),
  metadata: Schema.String,
});
export type Thread = Schema.Schema.Type<typeof Thread>;

// -- Messages -----------------------------------------------------------------

// TODO: actually build out the schema for AgentMessage
export const AgentMessageSchema = parseJson(
  Schema.declare((input: unknown): input is AgentMessage => true),
).pipe(Schema.asSchema);

export const Message = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  parentId: Schema.String.pipe(Schema.NullOr),
  content: AgentMessageSchema,
  createdAt: Schema.Number,
});
export type Message = Schema.Schema.Type<typeof Message>;

export const AgentResponseEvent = parseJson(
  Schema.declare((input: unknown): input is AgentEvent => true),
).pipe(Schema.asSchema);
export type AgentResponseEvent = Schema.Schema.Type<typeof AgentResponseEvent>;

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
  /** 5-field cron (min hr day mon wday) or 6-field with seconds prefix. e.g. "0 9 * * MON" */
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

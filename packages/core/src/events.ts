import { Cron } from "croner";
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { type EventDispatch, type EventTarget, type GuppyEvent, GuppyEventSchema } from "./types";

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventBus {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private crons = new Map<string, Cron>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private startTime = 0;
  private watcher: FSWatcher | null = null;
  private knownFiles = new Set<string>();

  constructor(
    private eventsDir: string,
    private dispatch: EventDispatch
  ) {}

  start(): void {
    this.startTime = Date.now();

    if (!existsSync(this.eventsDir)) {
      mkdirSync(this.eventsDir, { recursive: true });
    }

    this.scanExisting();

    this.watcher = watch(this.eventsDir, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      this.debounce(filename, () => this.handleFileChange(filename));
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();

    this.knownFiles.clear();
  }

  private debounce(filename: string, fn: () => void): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      filename,
      setTimeout(() => {
        this.debounceTimers.delete(filename);
        fn();
      }, DEBOUNCE_MS)
    );
  }

  private scanExisting(): void {
    let files: string[];
    try {
      files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const filename of files) {
      this.handleFile(filename);
    }
  }

  private handleFileChange(filename: string): void {
    const filePath = join(this.eventsDir, filename);

    if (!existsSync(filePath)) {
      this.handleDelete(filename);
    } else if (this.knownFiles.has(filename)) {
      this.cancelScheduled(filename);
      this.handleFile(filename);
    } else {
      this.handleFile(filename);
    }
  }

  private handleDelete(filename: string): void {
    if (!this.knownFiles.has(filename)) return;
    this.cancelScheduled(filename);
    this.knownFiles.delete(filename);
  }

  private cancelScheduled(filename: string): void {
    const timer = this.timers.get(filename);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(filename);
    }
    const cron = this.crons.get(filename);
    if (cron) {
      cron.stop();
      this.crons.delete(filename);
    }
  }

  private async handleFile(filename: string): Promise<void> {
    const filePath = join(this.eventsDir, filename);

    let event: GuppyEvent | null = null;
    let lastError: Error | null = null;
    let lastContent: string | null = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        lastContent = await readFile(filePath, "utf-8");
        event = this.parseEvent(lastContent);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < MAX_RETRIES - 1) {
          await sleep(RETRY_BASE_MS * 2 ** i);
        }
      }
    }

    if (!event) {
      console.warn(
        `[EventBus] Failed to parse ${filename} after ${MAX_RETRIES} retries:`,
        lastError?.message,
        lastContent
      );
      this.deleteFile(filename);
      return;
    }

    this.knownFiles.add(filename);

    switch (event.type) {
      case "immediate":
        this.handleImmediate(filename, event);
        break;
      case "one-shot":
        this.handleOneShot(filename, event);
        break;
      case "periodic":
        this.handlePeriodic(filename, event);
        break;
    }
  }

  private parseEvent(content: string): GuppyEvent {
    return Value.Parse(GuppyEventSchema, JSON.parse(content));
  }

  private handleImmediate(filename: string, event: GuppyEvent): void {
    const filePath = join(this.eventsDir, filename);

    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < this.startTime) {
        this.deleteFile(filename);
        return;
      }
    } catch {
      return;
    }

    this.execute(filename, event);
  }

  private handleOneShot(filename: string, event: GuppyEvent): void {
    if (event.type !== "one-shot") return;

    const targetMs = resolveScheduleMs(event.schedule, event.timezone);
    const now = Date.now();

    const delay = Math.max(0, targetMs - now);
    const timer = setTimeout(() => {
      this.timers.delete(filename);
      this.execute(filename, event);
    }, delay);

    this.timers.set(filename, timer);
  }

  private handlePeriodic(filename: string, event: GuppyEvent): void {
    if (event.type !== "periodic") return;

    try {
      const cron = new Cron(
        event.schedule,
        { timezone: event.timezone },
        () => {
          this.execute(filename, event, false);
        }
      );
      this.crons.set(filename, cron);
    } catch (err) {
      console.warn(
        `[EventBus] Invalid cron for ${filename}: ${event.schedule}`,
        err
      );
      this.deleteFile(filename);
    }
  }

  private execute(
    filename: string,
    event: GuppyEvent,
    deleteAfter = true
  ): void {
    let scheduleInfo: string;
    switch (event.type) {
      case "immediate":
        scheduleInfo = "immediate";
        break;
      case "one-shot":
        scheduleInfo = event.schedule;
        break;
      case "periodic":
        scheduleInfo = event.schedule;
        break;
    }

    const target: EventTarget = "threadId" in event
      ? { threadId: event.threadId }
      : { adapterId: event.adapterId, channelId: event.channelId };

    const formatted = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;
    this.dispatch(target, formatted);

    if (deleteAfter) {
      this.deleteFile(filename);
    }
  }

  private deleteFile(filename: string): void {
    const filePath = join(this.eventsDir, filename);
    try {
      unlinkSync(filePath);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        console.warn(`[EventBus] Failed to delete ${filename}:`, err);
      }
    }
    this.knownFiles.delete(filename);
  }
}

/**
 * Resolve a naive datetime string + IANA timezone to epoch ms.
 *
 * JS has no built-in "parse this datetime in timezone X" — `new Date()` always
 * interprets relative to the host machine's timezone. To work around this:
 *
 * 1. Parse the input string (JS interprets it in local time)
 * 2. Re-format into the target timezone using `toLocaleString("sv-SE", …)`.
 *    sv-SE outputs an ISO-ish format ("2025-06-15 09:00:00") unlike most
 *    locales which produce ambiguous formats like "6/15/2025, 9:00:00 AM".
 * 3. Append "Z" and re-parse to get "what UTC ms would this wall-clock be?"
 * 4. The difference between steps 1 and 3 is the timezone offset — apply it.
 */
export function resolveScheduleMs(
  schedule: string,
  timezone?: string
): number {
  if (!timezone) {
    return new Date(schedule).getTime();
  }

  const date = new Date(schedule);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid schedule date: ${schedule}`);
  }

  const localStr = date.toLocaleString("sv-SE", { timeZone: timezone });
  const utcMs = new Date(localStr + "Z").getTime();
  const offset = utcMs - date.getTime();
  return date.getTime() - offset;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

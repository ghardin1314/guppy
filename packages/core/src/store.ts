import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "chat";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { LogEntry, StoreOptions } from "./types";
import { encode, parseThreadId } from "./encode";

export class Store {
  readonly dataDir: string;

  constructor(options: StoreOptions) {
    this.dataDir = options.dataDir;
  }

  threadDir(compositeId: string): string {
    const { adapter, channelId, threadId } = parseThreadId(compositeId);
    return join(this.dataDir, adapter, encode(channelId), encode(threadId));
  }

  channelDir(compositeId: string): string {
    const { adapter, channelId } = parseThreadId(compositeId);
    return join(this.dataDir, adapter, encode(channelId));
  }

  transportDir(compositeId: string): string {
    const { adapter } = parseThreadId(compositeId);
    return join(this.dataDir, adapter);
  }

  logMessage(compositeId: string, message: Message): void {
    const dir = this.threadDir(compositeId);
    this.ensureDir(dir);

    const entry: LogEntry = {
      date: message.metadata.dateSent.toISOString(),
      messageId: message.id,
      userId: message.author.userId,
      userName: message.author.fullName,
      text: message.text,
      isBot: message.author.isBot === true || message.author.isMe,
    };

    // Kick off attachment downloads (fire-and-forget)
    const attachmentEntries: Array<{ original: string; local: string }> = [];
    for (const att of message.attachments) {
      if (att.url) {
        const filename = att.name ?? "attachment";
        const localName = `${Date.now()}_${this.sanitizeFilename(filename)}`;
        const localPath = join("attachments", localName);
        attachmentEntries.push({ original: att.url, local: localPath });

        const absPath = join(dir, localPath);
        this.downloadToFile(att.url, absPath, att.fetchData).catch((err) =>
          console.warn(`Attachment download failed: ${att.url}`, err)
        );
      }
    }

    if (attachmentEntries.length > 0) {
      entry.attachments = attachmentEntries;
    }

    const line = JSON.stringify(entry) + "\n";
    try {
      appendFileSync(join(dir, "log.jsonl"), line);
    } catch (err) {
      console.warn("Failed to append to log.jsonl", err);
    }
  }

  loadContext(compositeId: string): AgentMessage[] {
    const file = join(this.threadDir(compositeId), "context.jsonl");
    try {
      const content = readFileSync(file, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as AgentMessage);
    } catch {
      return [];
    }
  }

  saveContext(compositeId: string, messages: AgentMessage[]): void {
    const dir = this.threadDir(compositeId);
    this.ensureDir(dir);
    const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    const tmpFile = join(dir, "context.jsonl.tmp");
    const targetFile = join(dir, "context.jsonl");
    writeFileSync(tmpFile, content);
    renameSync(tmpFile, targetFile);
  }

  async downloadAttachment(
    compositeId: string,
    url: string,
    filename: string
  ): Promise<string> {
    const dir = this.threadDir(compositeId);
    const attDir = join(dir, "attachments");
    this.ensureDir(attDir);

    const safeName = `${Date.now()}_${this.sanitizeFilename(filename)}`;
    const absPath = join(attDir, safeName);
    await this.downloadToFile(url, absPath);
    return join("attachments", safeName);
  }

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private async downloadToFile(
    url: string,
    absPath: string,
    fetchData?: () => Promise<Buffer>
  ): Promise<void> {
    this.ensureDir(join(absPath, ".."));

    if (fetchData) {
      const data = await fetchData();
      await writeFile(absPath, data);
      return;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(absPath, buffer);
  }
}

import {
  existsSync,
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
import type { ImageContent } from "@mariozechner/pi-ai";
import type { LogEntry, StoreOptions } from "./types";
import { encode, parseThreadId } from "./encode";

export interface LoadedAttachments {
  images: ImageContent[];
  filePaths: string[];
}

/** Detect actual image MIME from magic bytes (platforms like Discord may lie). */
function detectImageMime(buf: Buffer): string | undefined {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  // RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return undefined;
}

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

  async logMessage(compositeId: string, message: Message): Promise<void> {
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

    const attachmentEntries: Array<{ original: string; local: string; mimeType?: string }> = [];
    const downloads: Promise<void>[] = [];
    for (const att of message.attachments) {
      if (att.url) {
        const filename = att.name ?? "attachment";
        const localName = `${Date.now()}_${this.sanitizeFilename(filename)}`;
        const localPath = join("attachments", localName);
        attachmentEntries.push({ original: att.url, local: localPath, mimeType: att.mimeType });

        const absPath = join(dir, localPath);
        downloads.push(
          this.downloadToFile(att.url, absPath, att.fetchData).catch((err) =>
            console.warn(`Attachment download failed: ${att.url}`, err)
          )
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

    if (downloads.length > 0) {
      await Promise.all(downloads);
    }
  }

  loadAttachments(compositeId: string, messageId: string): LoadedAttachments {
    const result: LoadedAttachments = { images: [], filePaths: [] };
    const entry = this.findLogEntry(compositeId, messageId);
    if (!entry?.attachments) return result;

    const threadDir = this.threadDir(compositeId);
    for (const att of entry.attachments) {
      const fullPath = join(threadDir, att.local);
      if (!existsSync(fullPath)) continue;

      if (att.mimeType?.startsWith("image/")) {
        try {
          const data = readFileSync(fullPath);
          const mimeType = detectImageMime(data) ?? att.mimeType;
          result.images.push({
            type: "image",
            mimeType,
            data: data.toString("base64"),
          });
        } catch {
          result.filePaths.push(fullPath);
        }
      } else {
        result.filePaths.push(fullPath);
      }
    }
    return result;
  }

  private findLogEntry(compositeId: string, messageId: string): LogEntry | undefined {
    const file = join(this.threadDir(compositeId), "log.jsonl");
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]) as LogEntry;
        if (entry.messageId === messageId) return entry;
      }
    } catch {
      // log file doesn't exist yet
    }
    return undefined;
  }

  loadContext(compositeId: string): AgentMessage[] {
    const file = join(this.threadDir(compositeId), "context.jsonl");
    try {
      const content = readFileSync(file, "utf-8");
      const messages = content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as AgentMessage);

      // Trim trailing error sequences (error assistant + its preceding user message)
      while (messages.length > 0) {
        const last = messages[messages.length - 1];
        if ("role" in last && last.role === "assistant" && "stopReason" in last && last.stopReason === "error") {
          messages.pop();
          // Also remove the user message that triggered the error
          const prev = messages[messages.length - 1];
          if (prev && "role" in prev && prev.role === "user") {
            messages.pop();
          }
          continue;
        }
        break;
      }

      return messages;
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

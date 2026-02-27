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
import {
  encode,
  adapterNameFrom,
  resolveThreadKeys,
  channelDir as channelDirFrom,
  threadDir as threadDirFrom,
  transportDir as transportDirFrom,
} from "./encode";

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
  private getAdapter: (name: string) => {
    name: string;
    channelIdFromThreadId?(threadId: string): string;
    fetchChannelInfo?(channelId: string): Promise<{ id: string; name?: string; isDM?: boolean }>;
  };

  constructor(options: StoreOptions & {
    getAdapter: (name: string) => {
      name: string;
      channelIdFromThreadId?(threadId: string): string;
      fetchChannelInfo?(channelId: string): Promise<{ id: string; name?: string; isDM?: boolean }>;
    };
  }) {
    this.dataDir = options.dataDir;
    this.getAdapter = options.getAdapter;
  }

  private resolve(compositeId: string) {
    const adapter = this.getAdapter(adapterNameFrom(compositeId));
    return resolveThreadKeys(adapter, compositeId);
  }

  threadDir(compositeId: string): string {
    const { adapter, channelKey, threadKey } = this.resolve(compositeId);
    return threadDirFrom(this.dataDir, adapter, channelKey, threadKey);
  }

  channelDir(compositeId: string): string {
    const { adapter, channelKey } = this.resolve(compositeId);
    return channelDirFrom(this.dataDir, adapter, channelKey);
  }

  transportDir(compositeId: string): string {
    const { adapter } = this.resolve(compositeId);
    return transportDirFrom(this.dataDir, adapter);
  }

  async logMessage(compositeId: string, message: Message): Promise<void> {
    const chanDir = this.channelDir(compositeId);
    const threadDir = this.threadDir(compositeId);
    this.ensureDir(chanDir);
    this.ensureDir(threadDir);

    const { threadKey } = this.resolve(compositeId);
    const encodedThreadKey = encode(threadKey);

    const entry: LogEntry = {
      date: message.metadata.dateSent.toISOString(),
      messageId: message.id,
      threadId: compositeId,
      userId: message.author.userId,
      userName: message.author.fullName,
      userHandle: message.author.userName,
      text: message.text,
      isBot: message.author.isBot === true || message.author.isMe,
    };

    this.writeChannelMeta(compositeId);

    const attachmentEntries: Array<{ original: string; local: string; mimeType?: string }> = [];
    const downloads: Promise<void>[] = [];
    for (const att of message.attachments) {
      if (att.url) {
        const filename = att.name ?? "attachment";
        const localName = `${Date.now()}_${this.sanitizeFilename(filename)}`;
        // Attachments stored in threadDir, path relative to channelDir
        const localPath = join(encodedThreadKey, "attachments", localName);
        attachmentEntries.push({ original: att.url, local: localPath, mimeType: att.mimeType });

        const absPath = join(chanDir, localPath);
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
      appendFileSync(join(chanDir, "log.jsonl"), line);
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

    const chanDir = this.channelDir(compositeId);
    for (const att of entry.attachments) {
      const fullPath = join(chanDir, att.local);
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

  // TODO: reads entire file into memory — fine up to ~50-100MB (~1 year of busy
  // channel traffic at ~9MB/month), but should be replaced with streaming/grep-based
  // lookup if the file grows large.
  private findLogEntry(compositeId: string, messageId: string): LogEntry | undefined {
    const file = join(this.channelDir(compositeId), "log.jsonl");
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
    const { threadKey } = this.resolve(compositeId);
    const encodedThreadKey = encode(threadKey);
    const chanDir = this.channelDir(compositeId);
    const attDir = join(chanDir, encodedThreadKey, "attachments");
    this.ensureDir(attDir);

    const safeName = `${Date.now()}_${this.sanitizeFilename(filename)}`;
    const absPath = join(attDir, safeName);
    await this.downloadToFile(url, absPath);
    return join(encodedThreadKey, "attachments", safeName);
  }

  /** Passive logging — logs to channel log without downloading attachments. */
  logChannelMessage(compositeId: string, message: Message): void {
    const chanDir = this.channelDir(compositeId);
    this.ensureDir(chanDir);

    const entry: LogEntry = {
      date: message.metadata.dateSent.toISOString(),
      messageId: message.id,
      threadId: compositeId,
      userId: message.author.userId,
      userName: message.author.fullName,
      userHandle: message.author.userName,
      text: message.text,
      isBot: message.author.isBot === true || message.author.isMe,
    };

    this.writeChannelMeta(compositeId);

    const line = JSON.stringify(entry) + "\n";
    try {
      appendFileSync(join(chanDir, "log.jsonl"), line);
    } catch (err) {
      console.warn("Failed to append to log.jsonl", err);
    }
  }

  /** Log a bot response to the channel log. */
  logBotResponse(compositeId: string, text: string): void {
    const chanDir = this.channelDir(compositeId);
    this.ensureDir(chanDir);

    const entry: LogEntry = {
      date: new Date().toISOString(),
      messageId: `bot-${Date.now()}`,
      threadId: compositeId,
      userId: "bot",
      userName: "bot",
      text,
      isBot: true,
    };

    const line = JSON.stringify(entry) + "\n";
    try {
      appendFileSync(join(chanDir, "log.jsonl"), line);
    } catch (err) {
      console.warn("Failed to append bot response to log.jsonl", err);
    }
  }

  /** Write meta.json for the channel directory (fire-and-forget, once per channel). */
  private writeChannelMeta(compositeId: string): void {
    const chanDir = this.channelDir(compositeId);
    const metaPath = join(chanDir, "meta.json");
    if (existsSync(metaPath)) return;

    const adapterName = adapterNameFrom(compositeId);
    const adapter = this.getAdapter(adapterName);
    const { channelKey } = this.resolve(compositeId);
    const channelId = `${adapterName}:${channelKey}`;

    // Write a minimal placeholder immediately so we don't re-enter
    const placeholder = JSON.stringify({ id: channelId });
    this.ensureDir(chanDir);
    writeFileSync(metaPath, placeholder + "\n");

    // Enrich with channel name async (fire-and-forget)
    if (adapter.fetchChannelInfo) {
      adapter.fetchChannelInfo(String(channelKey)).then((info) => {
        const meta = { id: channelId, name: info.name, isDM: info.isDM };
        writeFile(metaPath, JSON.stringify(meta) + "\n").catch(() => {});
      }).catch(() => {});
    }
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

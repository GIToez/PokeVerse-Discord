import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Logger } from "../../utils/logger.js";

const sessionSchema = z.object({
  sessionId: z.string(),
  bootId: z.string(),
  character: z.string(),
  level: z.number(),
  /** Unix seconds; absent for sessions first seen through admin.sessions. */
  loginTime: z.number().optional(),
  logoutTime: z.number().optional(),
  /** How the session ended: a logout event, a server restart, or a logout the bot missed. */
  ended: z.enum(["logout", "restart", "missed"]).optional(),
  /** Unix seconds when the bot first recorded the session. */
  recordedAt: z.number(),
  /** Messages posted to #player-activity for this session (deleted with the record). */
  messageIds: z.array(z.string()).default([]),
});

const fileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionSchema).default([]),
  /** Messages whose record was dropped before they could be deleted. */
  pendingDeletes: z.array(z.string()).default([]),
});

export type SessionRecord = z.infer<typeof sessionSchema>;

export interface ActivityStoreOptions {
  file: string;
  /** Records kept at most; the oldest are dropped (and their messages deleted) beyond it. */
  maxRecords?: number;
  logger: Logger;
  /** Delay before writing changes, so bursts of logins cause one write. */
  writeDelayMs?: number;
}

/**
 * Session records for the activity log: what is needed to correlate logins, logouts and
 * restarts, and to delete posted messages when they expire. Never stores IP addresses or
 * account ids. The file is written atomically with owner-only permissions.
 */
export class ActivityStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private pendingDeletes: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly maxRecords: number;

  constructor(private readonly options: ActivityStoreOptions) {
    this.maxRecords = options.maxRecords ?? 20_000;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.options.file)) {
      return;
    }
    try {
      const data = fileSchema.parse(JSON.parse(readFileSync(this.options.file, "utf8")));
      for (const session of data.sessions) {
        this.sessions.set(session.sessionId, session);
      }
      this.pendingDeletes = data.pendingDeletes;
    } catch (error) {
      this.options.logger.error("Activity file is damaged; starting with an empty activity history", {
        file: this.options.file,
        error: (error as Error).message,
      });
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  open(): SessionRecord[] {
    return [...this.sessions.values()].filter((session) => !session.ended);
  }

  /** Adds a record; false if the session is already known. */
  add(record: Omit<SessionRecord, "messageIds"> & { messageIds?: string[] }): boolean {
    if (this.sessions.has(record.sessionId)) {
      return false;
    }
    this.sessions.set(record.sessionId, { ...record, messageIds: record.messageIds ?? [] });
    while (this.sessions.size > this.maxRecords) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.pendingDeletes.push(...(this.sessions.get(oldest)?.messageIds ?? []));
      this.sessions.delete(oldest);
    }
    this.changed();
    return true;
  }

  update(sessionId: string, change: (record: SessionRecord) => void): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      change(record);
      this.changed();
    }
  }

  addMessage(sessionId: string, messageId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.messageIds.push(messageId);
    } else {
      this.pendingDeletes.push(messageId);
    }
    this.changed();
  }

  /**
   * Removes records whose last activity is older than `cutoff` (unix seconds) and returns
   * the message ids to delete, including ones left over from dropped records.
   */
  expire(cutoff: number): string[] {
    const messages = this.pendingDeletes;
    this.pendingDeletes = [];
    for (const [id, record] of this.sessions) {
      const lastActivity = Math.max(record.logoutTime ?? 0, record.loginTime ?? 0, record.recordedAt);
      if (lastActivity < cutoff) {
        messages.push(...record.messageIds);
        this.sessions.delete(id);
      }
    }
    if (messages.length > 0) {
      this.changed();
    }
    return messages;
  }

  /** Writes pending changes now (shutdown and tests). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const data = { version: 1, sessions: [...this.sessions.values()], pendingDeletes: this.pendingDeletes };
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      const temp = `${this.options.file}.tmp`;
      writeFileSync(temp, JSON.stringify(data) + "\n", { mode: 0o600 });
      renameSync(temp, this.options.file);
      chmodSync(this.options.file, 0o600);
    } catch (error) {
      this.options.logger.error("Could not write the activity file", { file: this.options.file, error: (error as Error).message });
    }
  }

  private changed(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => this.flush(), this.options.writeDelayMs ?? 2000);
    this.timer.unref();
  }
}

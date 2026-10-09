import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Notification, Notifier } from "./notifier.js";

export function botLogDirectory(override?: string): string {
  const configured = override ?? process.env.OPENTABLE_BOT_LOG_DIRECTORY;
  return path.resolve(configured?.trim() || ".local/logs");
}

export function notificationLogPath(directory = botLogDirectory()): string {
  return path.join(directory, "notifications.log");
}

export interface LocalNotifierOptions {
  readonly directory?: string;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Local-first notifier: each notification is printed and appended as one JSON
 * line to a log under the ignored .local directory. No network egress.
 */
export class LocalNotifier implements Notifier {
  private readonly logPath: string;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: LocalNotifierOptions = {}) {
    const directory =
      options.directory === undefined
        ? botLogDirectory()
        : botLogDirectory(options.directory);
    this.logPath = notificationLogPath(directory);
    this.write = options.write ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  async notify(event: Notification): Promise<void> {
    const line = JSON.stringify({
      timestamp: this.now().toISOString(),
      ...event,
    });
    this.write(line);
    await mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
    await appendFile(this.logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

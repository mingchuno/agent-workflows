import { open, stat } from "node:fs/promises";
import { matchIndex, terminalText } from "./text.js";

const chunkSize = 64 * 1024;
const checkpointInterval = 256;

export function presentLogLine(line: string, raw: boolean): string {
  if (raw) return terminalText(line);
  try {
    const event = JSON.parse(line);
    const body = event.item ?? event.data ?? event;
    const label = body.type ?? event.type ?? "event";
    const content =
      body.text ??
      body.content ??
      body.deltaContent ??
      body.message ??
      body.command;
    const output = body.aggregated_output ?? body.output;
    if (typeof body.toolName === "string")
      return terminalText(
        `${event.type ?? "tool"}: ${body.toolName} ${JSON.stringify(body.arguments ?? body.result ?? "")}`,
      );
    if (typeof content === "string")
      return terminalText(
        `${label}: ${content}${typeof output === "string" ? ` | ${output}` : ""}`,
      ).replaceAll("\n", " ↵ ");
  } catch {
    // Validation output and incomplete JSON records remain readable as text.
  }
  return terminalText(line);
}

/** Sparse byte offsets index the file; only requested pages hold decoded text. */
export class LogFile {
  private checkpoints = [0];
  private size = 0;
  private completeLines = 0;
  private tail = false;
  private identity = "";
  private modified = 0;
  revision = 0;
  private refreshTask: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  get count() {
    return this.completeLines + Number(this.tail);
  }

  refresh(signal: AbortSignal): Promise<void> {
    const task = this.refreshTask.then(() => this.updateIndex(signal));
    this.refreshTask = task.catch(() => {});
    return task;
  }

  private async updateIndex(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const metadata = await stat(this.path);
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (
      identity !== this.identity ||
      metadata.size < this.size ||
      (metadata.size === this.size && metadata.mtimeMs !== this.modified)
    ) {
      this.checkpoints = [0];
      this.size = 0;
      this.completeLines = 0;
      this.tail = false;
      this.revision++;
    }
    this.identity = identity;
    this.modified = metadata.mtimeMs;
    const file = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(chunkSize);
      while (this.size < metadata.size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(chunkSize, metadata.size - this.size),
          this.size,
        );
        signal.throwIfAborted();
        if (!bytesRead) break;
        for (let i = 0; i < bytesRead; i++) {
          this.tail = buffer[i] !== 10;
          if (buffer[i] === 10) {
            this.completeLines++;
            if (this.completeLines % checkpointInterval === 0)
              this.checkpoints[this.completeLines / checkpointInterval] =
                this.size + i + 1;
          }
        }
        this.size += bytesRead;
      }
    } finally {
      await file.close();
    }
  }

  private async *lines(start: number, signal: AbortSignal) {
    const checkpoint = Math.floor(Math.max(0, start) / checkpointInterval);
    let position = this.checkpoints[checkpoint] ?? this.size;
    let number = checkpoint * checkpointInterval;
    const file = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(chunkSize);
      let parts: Buffer[] = [];
      while (position < this.size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(chunkSize, this.size - position),
          position,
        );
        if (!bytesRead) break;
        let beginning = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] !== 10) continue;
          parts.push(Buffer.from(buffer.subarray(beginning, i)));
          if (number >= start)
            yield {
              number,
              text: Buffer.concat(parts).toString("utf8").replace(/\r$/, ""),
            };
          number++;
          parts = [];
          beginning = i + 1;
        }
        if (beginning < bytesRead)
          parts.push(Buffer.from(buffer.subarray(beginning, bytesRead)));
        position += bytesRead;
      }
      if (parts.length && number >= start)
        yield { number, text: Buffer.concat(parts).toString("utf8") };
    } finally {
      await file.close();
    }
  }

  async page(
    start: number,
    count: number,
    signal: AbortSignal,
  ): Promise<string[]> {
    const result: string[] = [];
    for await (const line of this.lines(start, signal)) {
      result.push(line.text);
      if (result.length >= count) break;
    }
    return result;
  }

  async search(options: {
    query: string;
    from: number;
    direction: 1 | -1;
    raw: boolean;
    signal: AbortSignal;
  }): Promise<number | undefined> {
    const { query, from, direction, raw, signal } = options;
    let first: number | undefined;
    let last: number | undefined;
    let previous: number | undefined;
    for await (const line of this.lines(0, signal)) {
      const text = presentLogLine(line.text, raw);
      if (matchIndex(text, query) < 0) continue;
      first ??= line.number;
      last = line.number;
      if (line.number < from) previous = line.number;
      if (direction === 1 && line.number > from) return line.number;
    }
    return direction === 1 ? first : (previous ?? last);
  }
}

import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { HTTPException } from "hono/http-exception";
import { actionAvailability } from "../monitor/actions.js";
import { LogFile, presentLogLine } from "../monitor/log-file.js";
import { logPageSize } from "../monitor/log-page.js";
import { createRedactor } from "../runtime/redaction.js";
import type { EventRecord, Store } from "../store.js";
import type { LogPage, RunEvidence } from "./contracts.js";

export class MonitorEvidence {
  private readonly logFiles = new Map<string, LogFile>();
  private readonly redact = createRedactor();
  constructor(
    private readonly store: Store,
    private readonly stateDirectory: string,
    private readonly projectIds: string[],
  ) {}

  async run(runId: string) {
    const runs = await this.store.runs();
    const run = runs.find(
      (candidate) =>
        candidate.id === runId && this.projectIds.includes(candidate.projectId),
    );
    if (!run) throw new HTTPException(404, { message: "Run not found" });
    return { run, runs };
  }

  async detail(runId: string): Promise<RunEvidence> {
    const { run, runs } = await this.run(runId);
    const [sessions, events, projects] = await Promise.all([
      this.store.invocations(run.id),
      this.recordedEvents(run.id),
      this.store.projects(),
    ]);
    const projection = actionAvailability({
      run,
      project: projects.find((project) => project.id === run.projectId),
      projectRuns: runs.filter(
        (candidate) => candidate.projectId === run.projectId,
      ),
      pending: false,
    });
    return {
      run,
      sessions,
      events,
      actionReasons: projection.actionReasons,
      logs: this.recordedLogs(run, sessions).map(
        ({ path: _path, ...log }) => log,
      ),
    };
  }

  private async recordedEvents(runId: string): Promise<EventRecord[]> {
    const events: EventRecord[] = [];
    let cursor = 0;
    for (;;) {
      const page = await this.store.events(cursor, runId);
      if (!page.length) return events;
      events.push(...page);
      cursor = page.at(-1)!.sequence;
    }
  }

  private recordedLogs(
    run: RunEvidence["run"],
    sessions: RunEvidence["sessions"],
  ) {
    return [
      ...sessions.map((session) => ({
        id: `session:${session.id}`,
        label: `${session.step} · ${session.provider} · invocation ${session.attempt}`,
        executionId: session.executionId,
        path: session.log,
      })),
      ...(run.stageLogs ?? []).map((log, index) => ({
        id: `stage:${index}`,
        label: `${log.step} stage`,
        executionId: log.executionId,
        path: log.path,
      })),
      ...(run.validation ?? []).map((check, index) => ({
        id: `check:${index}`,
        label: `${check.command} ${check.args.join(" ")}`,
        path: check.log,
      })),
      ...(run.reviewRounds ?? []).flatMap((round, roundIndex) =>
        round.validation.map((check, index) => ({
          id: `round:${roundIndex}:${index}`,
          label: `Repair round ${roundIndex + 1} · ${check.command} ${check.args.join(" ")}`,
          path: check.log,
        })),
      ),
    ];
  }

  async log(options: {
    runId: string;
    logId: string;
    start?: number;
    raw: boolean;
    query?: string;
    direction: 1 | -1;
    signal: AbortSignal;
  }): Promise<LogPage> {
    const { run } = await this.run(options.runId);
    const sessions = await this.store.invocations(run.id);
    const log = this.recordedLogs(run, sessions).find(
      (candidate) => candidate.id === options.logId,
    );
    if (!log)
      throw new HTTPException(404, { message: "Recorded log not found" });
    const path = await this.resolveLogPath(log.path);
    const file = this.cachedLogFile(path);
    await file.refresh(options.signal);
    const match = options.query
      ? await file.search({
          query: options.query,
          from: options.start ?? -1,
          direction: options.direction,
          raw: options.raw,
          signal: options.signal,
        })
      : undefined;
    const start = Math.max(
      0,
      Math.min(
        match ?? options.start ?? Math.max(0, file.count - logPageSize),
        Math.max(0, file.count - 1),
      ),
    );
    const lines = await file.page(start, logPageSize, options.signal);
    return {
      lines: lines.map((line) =>
        this.redact(presentLogLine(line, options.raw)),
      ),
      start,
      total: file.count,
      match,
    };
  }
  private async resolveLogPath(recordedPath: string) {
    const root = await realpath(this.stateDirectory);
    const path = await realpath(recordedPath);
    const within = relative(root, path);
    if (
      !within ||
      within === ".." ||
      within.startsWith("../") ||
      isAbsolute(within)
    )
      throw new HTTPException(403, {
        message: "Log is outside workflow state",
      });
    return path;
  }

  private cachedLogFile(path: string) {
    let file = this.logFiles.get(path);
    if (!file) {
      if (this.logFiles.size >= 16)
        this.logFiles.delete(this.logFiles.keys().next().value!);
      file = new LogFile(path);
      this.logFiles.set(path, file);
    }
    return file;
  }
}

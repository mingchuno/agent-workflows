import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { HelpDialog } from "./dialogs.js";
import { cells, colorFor } from "./format.js";
import { presentLogLine } from "./log-file.js";
import { matchIndex } from "./text.js";
import { useLogController } from "./use-log-controller.js";

export interface LogSource {
  path: string;
  label: string;
}
export function LogViewer({
  sources,
  initial,
  columns,
  rows,
  onBack,
}: {
  sources: LogSource[];
  initial: number;
  columns: number;
  rows: number;
  onBack: () => void;
}) {
  const [index, setIndex] = useState(initial);
  const source = sources[index] ?? sources[0];
  if (!source) return <Text>No logs recorded. Esc back</Text>;
  return (
    <LogScreen
      key={source.path}
      source={source}
      columns={columns}
      rows={rows}
      onBack={onBack}
      onNext={() => setIndex((value) => (value + 1) % sources.length)}
      multiple={sources.length > 1}
    />
  );
}
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? matchIndex(text, query) : -1;
  if (at < 0) return <Text>{text}</Text>;
  return (
    <Text>
      {text.slice(0, at)}
      <Text inverse bold>
        {text.slice(at, at + query.length)}
      </Text>
      {text.slice(at + query.length)}
    </Text>
  );
}
function LogScreen({
  source,
  columns,
  rows,
  onBack,
  onNext,
  multiple,
}: {
  source: LogSource;
  columns: number;
  rows: number;
  onBack: () => void;
  onNext: () => void;
  multiple: boolean;
}) {
  const log = useLogController(source.path, columns, rows);
  const {
    height,
    following,
    horizontal,
    raw,
    lines,
    total,
    message,
    editing,
    draft,
    query,
    searching,
    position,
  } = log;
  const [help, setHelp] = useState(false);
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.eventType === "release") return;
    if (help) return;
    if (key.escape) {
      if (!log.dismissSearch()) onBack();
      return;
    }
    if (editing) {
      if (key.return) log.applySearch();
      else if (key.backspace || key.delete) log.eraseDraft();
      else if (
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.tab
      )
        log.appendDraft(input);
      return;
    }
    if (input === "/") log.beginSearch();
    else if (input === "n" || input === "N")
      log.repeatSearch(input === "n" ? 1 : -1);
    else if (input === "f") log.follow();
    else if (input === "R") log.toggleRaw();
    else if (key.tab && multiple) onNext();
    else if (input === "?") setHelp(true);
    else if (key.upArrow || input === "k") log.scroll(-1);
    else if (key.downArrow || input === "j") log.scroll(1);
    else if (key.pageUp) log.scroll(-height);
    else if (key.pageDown || input === " ") log.scroll(height);
    else if (key.home || input === "g") log.firstPage();
    else if (key.end || input === "G") log.lastPage();
    else if (key.leftArrow) log.pan(-20);
    else if (key.rightArrow) log.pan(20);
  });
  if (help)
    return (
      <HelpDialog
        columns={columns}
        rows={rows}
        initialPage={2}
        onClose={() => setHelp(false)}
      />
    );
  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Text bold color={colorFor("running")} wrap="truncate">
        {cells(`Logs · ${source.label}`, columns)}
      </Text>
      <Text wrap="truncate">{cells(source.path, columns)}</Text>
      <Text>
        {following ? "LIVE FOLLOW" : "SCROLLING"} · {raw ? "Raw" : "Readable"} ·
        lines {total ? position + 1 : 0}–{Math.min(total, position + height)}/
        {total}
        {searching ? " · Searching…" : ""}
      </Text>
      <Box height={height} flexDirection="column" overflow="hidden">
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the absolute file line is the stable record identity.
          <Text key={`${position + index}`} wrap="truncate">
            <Highlight
              text={cells(presentLogLine(line, raw), columns, horizontal)}
              query={query}
            />
          </Text>
        ))}
      </Box>
      <Text wrap="truncate">
        {cells(
          editing
            ? `/${draft}▏`
            : query
              ? `Search: ${query}${message ? ` · ${message}` : ""}`
              : message,
          columns,
        )}
      </Text>
      <Text color={colorFor("running")} wrap="truncate">
        {editing
          ? "Enter search · Esc cancel"
          : `/ search · n/N match · f follow · R ${raw ? "readable" : "raw"} · ${multiple ? "Tab log · " : ""}Esc back · ? help`}
      </Text>
      <Text dimColor wrap="truncate">
        {cells(
          "↑↓ scroll · PgUp/PgDn page · ←→ pan · workflow continues in background",
          columns,
        )}
      </Text>
    </Box>
  );
}

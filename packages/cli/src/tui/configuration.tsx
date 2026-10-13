import {
  type Configuration,
  configurationJson,
} from "@mingchuno/agent-workflows-core";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { tuiRefreshIntervalMs } from "./constants.js";
import type { MonitorSource } from "./data.js";
import { wrapLines } from "./format.js";
import { Lines } from "./views.js";

export function ConfigurationView({
  source,
  columns,
  rows,
  onClose,
}: {
  source: MonitorSource;
  columns: number;
  rows: number;
  onClose: () => void;
}) {
  const [configuration, setConfiguration] = useState<Configuration>();
  const [status, setStatus] = useState("Loading active configuration...");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let closed = false;
    let busy = false;
    let hasConfiguration = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!source.configuration)
          throw new Error("Active runner configuration unavailable");
        const candidate = await source.configuration();
        if (closed) return;
        hasConfiguration = true;
        setConfiguration(candidate);
        setStatus(
          "Accepted runner settings; paths and prompt-file references are unexpanded.",
        );
      } catch (error) {
        if (!closed)
          setStatus(
            `${hasConfiguration ? "Stale configuration" : "Configuration unavailable"}: ${String(error)}. Start the runner or reconnect.`,
          );
      } finally {
        busy = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), tuiRefreshIntervalMs);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [source]);
  const lines = configuration
    ? configurationJson(configuration).trimEnd().split("\n")
    : [];
  const height = rows - 6;
  const maximum = Math.max(0, wrapLines(lines, columns - 4).length - height);
  const currentOffset = Math.min(offset, maximum);
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.eventType === "release") return;
    if (key.escape || input === "C" || input === "q") onClose();
    else if (key.home) setOffset(0);
    else if (key.end) setOffset(maximum);
    else if (key.upArrow || key.pageUp)
      setOffset(Math.max(0, currentOffset - (key.pageUp ? height : 1)));
    else if (key.downArrow || key.pageDown)
      setOffset(Math.min(maximum, currentOffset + (key.pageDown ? height : 1)));
  });
  return (
    <Box width={columns} height={rows} paddingX={2} flexDirection="column">
      <Text bold>Active configuration</Text>
      <Lines lines={[status]} width={columns - 4} height={2} />
      <Box height={1} />
      <Lines
        lines={lines}
        width={columns - 4}
        height={height}
        offset={currentOffset}
      />
      <Text dimColor>
        Up/Down scroll · PgUp/PgDn page · Home/End · Esc close
      </Text>
      <Text dimColor>
        {currentOffset + 1}/{maximum + 1} scroll positions · Schema-validated
        JSON
      </Text>
    </Box>
  );
}

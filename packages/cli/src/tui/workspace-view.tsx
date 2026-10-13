import type { RunRecord } from "@mingchuno/agent-workflows-core";
import { Box, Text } from "ink";
import { chromeCells, colorFor, wrapLines } from "./format.js";
import { ellipsis, runIdentity, runState } from "./presentation.js";
import { type RunSection, runSections } from "./sections.js";
import { Shortcuts } from "./shortcuts.js";
import { Lines, wrapDetailLines } from "./views.js";

export function RunWorkspace({
  run,
  section,
  content,
  now,
  dashboard,
  sessions,
  detailError,
}: {
  run: RunRecord;
  section: RunSection;
  now: number;
  dashboard: boolean;
  detailError?: string;
  content: { lines: string[]; width: number; height: number; offset: number };
  sessions?: { lines: string[]; offset: number };
}) {
  const { width, height, offset, lines } = content;
  const identity = wrapLines([runIdentity(run)], width);
  const title =
    identity.length > 2
      ? [identity[0], ellipsis(`${identity[1]} ...`, width)]
      : identity;
  const wrapped = wrapDetailLines(lines, width);
  const sectionLabel = sessions
    ? "Agent sessions · Up/Down select · l log"
    : "Overview · Enter inspect · d diagnostic";
  return (
    <Box
      width={width}
      height={height + 5}
      flexDirection="column"
      overflow="hidden"
    >
      <Box height={2} flexShrink={0} flexDirection="column">
        <Text bold wrap="truncate">
          {title[0] || " "}
        </Text>
        <Text bold wrap="truncate">
          {title[1] || " "}
        </Text>
      </Box>
      <Text color={colorFor(run.outcome)} wrap="truncate">
        {ellipsis(runState(run, now), width)}
      </Text>
      {dashboard || sessions ? (
        <Text bold color={colorFor("running")} wrap="truncate">
          {chromeCells(sectionLabel, width)}
        </Text>
      ) : (
        <Text wrap="truncate">
          {runSections.map((item, index) => (
            <Text key={item}>
              {index > 0 ? "  " : ""}
              <Text bold={item === section} inverse={item === section}>
                <Text bold color={colorFor("running")}>
                  {index + 1}
                </Text>{" "}
                {item === section
                  ? `[${item}]`
                  : width < 110
                    ? [
                        "Home",
                        "Activity",
                        "Checks",
                        "Exec",
                        "Error",
                        "Tech",
                        "Actions",
                      ][index]
                    : item}
              </Text>
            </Text>
          ))}
        </Text>
      )}
      <Text wrap="truncate">
        {chromeCells(
          detailError ||
            (sessions
              ? "a sessions · Tab pane"
              : `lines ${offset + 1}–${Math.min(offset + height, wrapped.length)} of ${wrapped.length}`),
          width,
        )}
      </Text>
      <Lines
        lines={sessions?.lines ?? lines}
        width={width}
        height={height}
        offset={sessions?.offset ?? offset}
        renderLine={
          sessions ? undefined : (line) => workspaceLine(line, section, width)
        }
      />
    </Box>
  );
}

function workspaceLine(line: string, section: RunSection, width: number) {
  if (section === "Overview") {
    const field = line.match(/^(Problem|Evidence|Next|Action)(\s+)(.*)$/);
    if (field)
      return (
        <Text>
          <Text
            bold
            color={
              field[1] === "Problem"
                ? colorFor("failed")
                : field[1] === "Next" || field[1] === "Action"
                  ? colorFor("running")
                  : undefined
            }
          >
            {field[1]}
          </Text>
          {field[2]}
          {field[1] === "Action" ? (
            <Shortcuts
              text={field[3]!}
              width={Math.max(1, width - field[1]!.length - field[2]!.length)}
            />
          ) : (
            field[3]
          )}
        </Text>
      );
    if (/^(d full diagnostic|2 Activity)/.test(line))
      return <Shortcuts text={line} width={width} />;
    if (line === "Full subject") return <Text bold>{line}</Text>;
  }
  if (section === "Actions" && /^[crsF] (recover|retry|stop)/.test(line)) {
    const split = line.indexOf(":");
    if (split >= 0)
      return (
        <Text>
          <Shortcuts text={line.slice(0, split)} width={width} />
          {line.slice(split)}
        </Text>
      );
    return <Shortcuts text={line} width={width} />;
  }
  return line || " ";
}

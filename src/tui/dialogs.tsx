import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";
import { colorFor, wrapLines } from "./format.js";
import { Lines } from "./views.js";

type DialogSize = { columns: number; rows: number };
const dialogHorizontalMargin = 8;
const dialogVerticalMargin = 4;
const dialogContentWidthOffset = 6;
const dialogChromeHeight = 11;

function Dialog({
  columns,
  rows,
  width,
  height,
  title,
  children,
}: DialogSize & {
  width: number;
  height: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <Box
      width={columns}
      height={rows}
      justifyContent="center"
      alignItems="center"
    >
      <Box
        width={width}
        height={height}
        borderStyle="round"
        borderColor={colorFor("running")}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Text bold>{title}</Text>
        <Box height={1} flexShrink={0} />
        {children}
      </Box>
    </Box>
  );
}

const helpPages = [
  {
    title: "Navigation",
    rows: [
      ["Tab", "Next pane"],
      ["Shift+Tab", "Previous pane"],
      ["↑ / ↓", "Select a run or session"],
      ["← / →", "Select project"],
      ["Enter", "Open run details"],
      ["Esc", "Return from details"],
      ["↑ / ↓", "Scroll summary or details"],
      ["PgUp / PgDn", "Page through details"],
      ["?", "Open keyboard shortcuts"],
      ["q / Ctrl-C", "Close monitor; workflows continue"],
    ],
  },
  {
    title: "Workflow",
    rows: [
      ["p", "Pause or resume project intake"],
      ["s", "Stop selected run"],
      ["r", "Retry as a new run"],
      ["c", "Recover failed publication"],
      ["[ / ]", "Inspect previous or next step event"],
      ["End", "Follow latest step event"],
      ["a", "Focus agent sessions"],
      ["l", "Open selected agent log"],
      ["v", "Open validation logs"],
    ],
    note: "Stop, retry and recovery open a confirmation dialog.",
  },
  {
    title: "Logs",
    rows: [
      ["↑ / ↓", "Scroll records"],
      ["j / k", "Scroll down or up"],
      ["PgUp / PgDn", "Scroll one page"],
      ["← / →", "Pan long lines"],
      ["Home / g", "Go to first page"],
      ["End / G", "Go to last page"],
      ["f", "Resume live follow"],
      ["R", "Toggle readable or raw text"],
      ["Tab", "Select next log"],
      ["Esc", "Return to previous view"],
    ],
  },
  {
    title: "Search",
    rows: [
      ["/", "Start a literal search"],
      ["Enter", "Apply search"],
      ["n", "Next matching record"],
      ["N", "Previous matching record"],
      ["Esc", "Dismiss search before leaving logs"],
    ],
    note: "Search covers the whole selected log and wraps. Lowercase ignores case; uppercase makes it case-sensitive. Search pauses live follow.",
  },
  {
    title: "Timing",
    rows: [],
    note: "Execution duration includes preparation and waits within one execution.\n\nQueue waiting and gaps before recovery are shown separately.\n\nDatabase connectivity does not establish runner liveness.",
  },
];
export function HelpDialog({
  columns,
  rows,
  onClose,
  initialPage = 0,
}: DialogSize & {
  onClose: () => void;
  initialPage?: number;
}) {
  const [page, setPage] = useState(initialPage);
  const [offset, setOffset] = useState(0);
  const width = Math.min(86, columns - dialogHorizontalMargin);
  const height = Math.min(23, rows - dialogVerticalMargin);
  const bodyHeight = height - dialogChromeHeight;
  const current = helpPages[page]!;
  const content = [
    ...current.rows.map(
      ([key, description]) => `${key!.padEnd(17)}${description}`,
    ),
    ...(current.note ? ["", current.note] : []),
  ];
  const maxOffset = Math.max(
    0,
    wrapLines(content, width - dialogContentWidthOffset).length - bodyHeight,
  );
  const changePage = (delta: number) => {
    setPage((value) => (value + delta + helpPages.length) % helpPages.length);
    setOffset(0);
  };
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.eventType === "release") return;
    if (key.escape || input === "?") onClose();
    else if (key.tab) changePage(key.shift ? -1 : 1);
    else if (key.leftArrow) changePage(-1);
    else if (key.rightArrow) changePage(1);
    else if (key.upArrow || key.pageUp)
      setOffset((value) =>
        Math.max(0, Math.min(value, maxOffset) - (key.pageUp ? bodyHeight : 1)),
      );
    else if (key.downArrow || key.pageDown)
      setOffset((value) =>
        Math.min(maxOffset, value + (key.pageDown ? bodyHeight : 1)),
      );
  });
  return (
    <Dialog
      columns={columns}
      rows={rows}
      width={width}
      height={height}
      title="Keyboard shortcuts"
    >
      <Box gap={1}>
        {helpPages.map((item, index) => (
          <Text key={item.title} bold={index === page} inverse={index === page}>
            {index === page ? ">" : ""}
            {item.title}
          </Text>
        ))}
      </Box>
      <Box height={1} flexShrink={0} />
      <Lines
        lines={content}
        width={width - dialogContentWidthOffset}
        height={bodyHeight}
        offset={offset}
      />
      <Box height={1} flexShrink={0} />
      <Text dimColor>
        {page + 1}/{helpPages.length}
        {maxOffset
          ? ` · ↑↓ scroll (${Math.min(offset, maxOffset) + 1}/${maxOffset + 1})`
          : ""}
      </Text>
      <Text color={colorFor("running")}>Tab / ←→ page · Esc close</Text>
    </Dialog>
  );
}

export function ConfirmDialog({
  columns,
  rows,
  title,
  subject,
  description,
  available,
  onCancel,
  onConfirm,
}: DialogSize & {
  title: string;
  subject: string;
  description: string;
  available: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [selected, setSelected] = useState<"cancel" | "confirm">("cancel");
  const [offset, setOffset] = useState(0);
  const width = Math.min(78, columns - dialogHorizontalMargin);
  const content = [
    subject,
    "",
    description,
    ...(!available
      ? ["", "This action is no longer available. Cancel to refresh the view."]
      : []),
  ];
  const contentLines = wrapLines(
    content,
    width - dialogContentWidthOffset,
  ).length;
  const height = Math.min(
    rows - dialogVerticalMargin,
    contentLines + dialogChromeHeight,
  );
  const bodyHeight = height - dialogChromeHeight;
  const maxOffset = Math.max(0, contentLines - bodyHeight);
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.eventType === "release") return;
    if (key.escape || input === "n") onCancel();
    else if (key.tab || key.leftArrow || key.rightArrow)
      setSelected((value) => (value === "cancel" ? "confirm" : "cancel"));
    else if (key.return) {
      if (selected === "cancel") onCancel();
      else if (available) onConfirm();
    } else if (key.upArrow)
      setOffset((value) => Math.max(0, Math.min(value, maxOffset) - 1));
    else if (key.downArrow)
      setOffset((value) => Math.min(maxOffset, value + 1));
  });
  return (
    <Dialog
      columns={columns}
      rows={rows}
      width={width}
      height={height}
      title={title}
    >
      <Lines
        lines={content}
        width={width - dialogContentWidthOffset}
        height={bodyHeight}
        offset={offset}
      />
      <Box height={1} flexShrink={0} />
      <Box gap={3} justifyContent="flex-end">
        <Text bold={selected === "cancel"} inverse={selected === "cancel"}>
          {selected === "cancel" ? "> Cancel " : "  Cancel "}
        </Text>
        <Text
          bold={selected === "confirm"}
          inverse={selected === "confirm"}
          dimColor={!available}
        >
          {selected === "confirm" ? "> Confirm " : "  Confirm "}
          {!available ? "(unavailable)" : ""}
        </Text>
      </Box>
      <Box height={1} flexShrink={0} />
      <Text color={colorFor("running")}>
        Tab switch · Enter select · Esc cancel
      </Text>
      <Text dimColor>
        {maxOffset
          ? "↑↓ scroll message"
          : "Only Enter on Confirm submits the action."}
      </Text>
    </Dialog>
  );
}

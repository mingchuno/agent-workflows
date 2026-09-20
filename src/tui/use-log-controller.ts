import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { screenChromeRows, tuiRefreshIntervalMs } from "./constants.js";
import { LogFile, presentLogLine } from "./log-file.js";
import { matchIndex, terminalText } from "./text.js";

/** Owned by one keyed log screen; unmount cancels polling and search. */
export function useLogController(path: string, columns: number, rows: number) {
  const file = useMemo(() => new LogFile(path), [path]);
  const height = Math.max(1, rows - screenChromeRows);
  const [following, setFollowing] = useState(true);
  const [top, setTop] = useState(0);
  const [horizontal, setHorizontal] = useState(0);
  const [raw, setRaw] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("Loading log…");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchController = useRef<AbortController | undefined>(undefined);
  const position = useRef(0);
  useEffect(() => () => searchController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        await file.refresh(controller.signal);
        const nextTop = following
          ? Math.max(0, file.count - height)
          : Math.min(top, Math.max(0, file.count - 1));
        const page = await file.page(nextTop, height, controller.signal);
        if (controller.signal.aborted) return;
        position.current = nextTop;
        if (!following && nextTop !== top) setTop(nextTop);
        setTotal(file.count);
        setLines(page);
        setMessage((current) =>
          !file.count
            ? "No output yet; waiting for log data"
            : /^(Loading log|Log unavailable|No output yet)/.test(current)
              ? ""
              : current,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setLines([]);
          setMessage(`Log unavailable: ${String(error)}`);
        }
      } finally {
        busy = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), tuiRefreshIntervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [file, following, top, height]);

  const search = async (value: string, direction: 1 | -1, first = false) => {
    if (!value) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setFollowing(false);
    setQuery(value);
    setSearching(true);
    try {
      const match = await file.search({
        query: value,
        from: first ? position.current - 1 : position.current,
        direction,
        raw,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (match === undefined) setMessage(`No matches: ${value}`);
      else {
        position.current = match;
        setTop(match);
        const [line] = await file.page(match, 1, controller.signal);
        if (controller.signal.aborted) return;
        const text = presentLogLine(line ?? "", raw);
        const at = matchIndex(text, value);
        setHorizontal(
          stringWidth(text.slice(0, at + value.length)) > columns
            ? Math.max(0, stringWidth(text.slice(0, at)) - 8)
            : 0,
        );
        setMessage(`Match on line ${match + 1} (wraps at file boundary)`);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(`Search failed: ${String(error)}`);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };
  const scroll = (delta: number) => {
    setFollowing(false);
    const next = Math.max(
      0,
      Math.min(Math.max(0, total - 1), position.current + delta),
    );
    position.current = next;
    setTop(next);
  };
  const cancelSearch = () => {
    searchController.current?.abort();
    setSearching(false);
  };
  return {
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
    position: position.current,
    scroll,
    dismissSearch() {
      cancelSearch();
      if (!editing && !query) return false;
      setEditing(false);
      setQuery("");
      setDraft("");
      return true;
    },
    beginSearch() {
      setFollowing(false);
      setTop(position.current);
      setDraft("");
      setEditing(true);
    },
    applySearch() {
      setEditing(false);
      void search(draft, 1, true);
    },
    repeatSearch(direction: 1 | -1) {
      void search(query, direction);
    },
    eraseDraft() {
      setDraft((value) => Array.from(value).slice(0, -1).join(""));
    },
    appendDraft(input: string) {
      setDraft(
        (value) =>
          value +
          terminalText(input)
            .replaceAll("\n", "")
            .replaceAll("\r", "")
            .replaceAll("\t", ""),
      );
    },
    follow() {
      cancelSearch();
      setQuery("");
      setFollowing(true);
      setHorizontal(0);
    },
    toggleRaw() {
      cancelSearch();
      setRaw(!raw);
      setQuery("");
    },
    firstPage() {
      setFollowing(false);
      position.current = 0;
      setTop(0);
    },
    lastPage() {
      setFollowing(false);
      position.current = Math.max(0, total - height);
      setTop(position.current);
    },
    pan(delta: number) {
      setHorizontal((value) => Math.max(0, value + delta));
    },
  };
}

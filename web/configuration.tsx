import { useQuery } from "@tanstack/react-query";
import { defaultStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import type { Configuration } from "../src/config.js";
import { readMonitor } from "./api.js";
import styles from "./app.module.css";
import configurationStyles from "./configuration.module.css";

const expandOverview = (level: number) => level < 1;
const jsonStyles = {
  ...defaultStyles,
  container: configurationStyles.tree,
  childFieldsContainer: configurationStyles.children,
  basicChildStyle: configurationStyles.node,
  label: configurationStyles.label,
  stringValue: configurationStyles.string,
  numberValue: configurationStyles.number,
  booleanValue: configurationStyles.boolean,
  punctuation: configurationStyles.punctuation,
  stringifyStringValues: true,
  quotesForFieldNames: true,
  expandIcon: configurationStyles.expand,
  collapseIcon: configurationStyles.collapse,
};

export function ConfigurationView({
  reloadDisabled,
  onReload,
}: {
  reloadDisabled: boolean;
  onReload: () => void;
}) {
  const configuration = useQuery({
    queryKey: ["configuration"],
    queryFn: ({ signal }) =>
      readMonitor<Configuration>("/api/configuration", signal),
    refetchInterval: 1000,
    retry: false,
  });
  return (
    <section
      className={configurationStyles.view}
      aria-labelledby="configuration-heading"
    >
      <div className={configurationStyles.heading}>
        <h2 id="configuration-heading">Active configuration</h2>
        <button type="button" disabled={reloadDisabled} onClick={onReload}>
          Reload configuration
        </button>
      </div>
      <p className={styles.muted}>
        Accepted runner settings with inheritance and defaults resolved. Paths
        and prompt-file references are unexpanded.
      </p>
      {configuration.isError && (
        <div className={styles.warning} role="alert">
          <strong>
            {configuration.data
              ? "Displayed configuration is stale."
              : "Active configuration unavailable."}
          </strong>
          <p>{configuration.error.message}</p>
          <button type="button" onClick={() => void configuration.refetch()}>
            Try again
          </button>
        </div>
      )}
      {configuration.isPending && (
        <p role="status">Loading active configuration…</p>
      )}
      {configuration.data && (
        <>
          <p className={configurationStyles.hint}>
            Expand a field to inspect its values. Use arrow keys to navigate,
            and Enter to expand or collapse.
          </p>
          <fieldset
            className={configurationStyles.viewer}
            aria-label="JSON tree keyboard controls"
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              if (
                event.target instanceof HTMLElement &&
                event.target.getAttribute("role") === "button"
              ) {
                event.preventDefault();
                event.target.click();
              }
            }}
          >
            <JsonView
              data={configuration.data}
              style={jsonStyles}
              shouldExpandNode={expandOverview}
              aria-label="Active configuration JSON"
            />
          </fieldset>
        </>
      )}
    </section>
  );
}

import { Text } from "ink";
import { chromeCells, colorFor } from "./format.js";

/** Only generated shortcut copy belongs here; recorded evidence stays literal. */
export function Shortcuts({ text, width }: { text: string; width: number }) {
  const parts = chromeCells(text, width).split(/([·|])/);
  return (
    <Text wrap="truncate">
      {parts.map((part, index) => {
        const match = part.match(/^(\s*)(\S+)(\s+.*)$/);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed stateless shortcut segments.
          <Text key={index}>
            {match ? (
              <>
                {match[1]}
                <Text bold inverse color={colorFor("running")}>
                  {match[2]}
                </Text>
                {match[3]}
              </>
            ) : (
              part
            )}
          </Text>
        );
      })}
    </Text>
  );
}

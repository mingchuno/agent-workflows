import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BlockedError } from "../domain.js";

/** Resolve through existing ancestors, rejecting source-tree writes before mkdir. */
export async function assertStateDirectory(
  checkout: string,
  requested: string,
): Promise<string> {
  const canonicalCheckout = await realpath(checkout);
  let ancestor = resolve(requested);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      const destination = resolve(canonical, ...suffix);
      const location = relative(canonicalCheckout, destination);
      if (
        !location ||
        (!isAbsolute(location) &&
          location !== ".." &&
          !location.startsWith(`..${sep}`))
      )
        throw new BlockedError(
          "State directory must be outside the managed checkout",
        );
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(relative(dirname(ancestor), ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

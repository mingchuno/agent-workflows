import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function snapshot(stage) {
  const names = [
    "AGENT_WORKFLOWS_DATABASE_URL",
    "GITHUB_TOKEN",
    "CUSTOM_CONNECTION",
    "CUSTOM_CREDENTIAL",
    "APP_GREETING",
    "APP_REFERENCE",
    "APP_COMMAND",
    "APP_BACKTICKS",
    "APP_OVERRIDE",
    "APP_EMPTY",
  ];
  const values = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  await writeFile(
    join(process.env.AW_TEST_OUTPUT, `${stage}.json`),
    JSON.stringify(values),
  );
  return values;
}
if (process.argv[2] === "validation") {
  const values = await snapshot("validation");
  console.log(JSON.stringify(values));
}

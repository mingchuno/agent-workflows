import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const mode = process.argv[2];
if (process.argv.length > 3 || (mode && mode !== "--pack-smoke"))
  throw new Error("Usage: node scripts/test.mjs [--pack-smoke]");
let directory;
const testDirectory = await mkdtemp(join(tmpdir(), "agent-workflows-tests-"));
function run(executable, args) {
  return execFileSync(executable, args, { stdio: "pipe", encoding: "utf8" });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    directory = await mkdtemp(join(tmpdir(), "agent-workflows-postgres-"));
    const data = join(directory, "data");
    const port = await freePort();
    run("initdb", [
      "-D",
      data,
      "-A",
      "trust",
      "--no-locale",
      "-U",
      "agent_workflows",
    ]);
    run("pg_ctl", [
      "-D",
      data,
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-p ${port} -h 127.0.0.1 -k ${directory}`,
      "start",
    ]);
    run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "agent_workflows",
      "agent_workflows_test",
    ]);
    url = `postgresql://agent_workflows@127.0.0.1:${port}/agent_workflows_test`;
  }
  const signedOut = join(testDirectory, "signed-out");
  await mkdir(signedOut);
  for (const name of ["gh", "glab"])
    await writeFile(join(signedOut, name), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
  const files = (await readdir("tests"))
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => join("tests", file));
  const child = spawn(
    process.execPath,
    mode === "--pack-smoke"
      ? ["scripts/pack-smoke.mjs"]
      : ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_DATABASE_URL: url,
        // Keep the developer's gh and glab sign-in out of hosting fallback;
        // gh also reads the system keyring, so shadow both executables.
        PATH: `${signedOut}${delimiter}${process.env.PATH}`,
        GITHUB_TOKEN: "",
        GITLAB_TOKEN: "",
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error(
    "Tests require PostgreSQL binaries on PATH or TEST_DATABASE_URL pointing to a disposable PostgreSQL database.",
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await rm(testDirectory, { recursive: true, force: true });
  if (directory) {
    try {
      run("pg_ctl", ["-D", join(directory, "data"), "-m", "immediate", "stop"]);
    } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

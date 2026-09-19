import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const files = (await readdir("tests"))
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => join("tests", file));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
    { stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: url } },
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

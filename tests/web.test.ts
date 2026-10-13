import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitFor } from "./runner-fixtures.js";
import { seedWebEvidence, unusedPort, webRunner } from "./web-fixtures.js";

function requestWithHost(url: string, host: string) {
  return new Promise<number>((done, reject) => {
    const incoming = request(url, { headers: { host } }, (response) => {
      response.resume();
      done(response.statusCode!);
    });
    incoming.once("error", reject);
    incoming.end();
  });
}

test("run starts a protected local monitor and acknowledges operator commands", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const runner = await webRunner();
  try {
    const { origin, cookie } = await runner.access();
    const localAddress = Object.values(networkInterfaces())
      .flat()
      .find(
        (address) => address?.family === "IPv4" && !address.internal,
      )?.address;
    if (localAddress)
      await assert.rejects(
        fetch(`http://${localAddress}:${new URL(origin).port}/api/snapshot`, {
          signal: AbortSignal.timeout(500),
        }),
      );
    assert.equal((await fetch(origin + "/api/snapshot")).status, 401);
    const snapshot = async () =>
      (await fetch(origin + "/api/snapshot", { headers: { cookie } })).json();
    assert.equal((await snapshot()).projects[0].id, "fixture");
    const response = await fetch(origin + "/api/commands", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ kind: "pause", target: "fixture" }),
    });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    await waitFor(async () =>
      (await snapshot()).commands.some(
        (command: { id: string; status: string }) =>
          command.id === id && command.status === "success",
      ),
    );
    assert.equal((await snapshot()).projects[0].paused, true);
  } finally {
    await runner.stop();
  }
});

test("run uses the documented default web port and closes the server on normal shutdown", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const runner = await webRunner({ flags: [] });
  const { origin, cookie } = await runner.access();
  try {
    assert.equal(new URL(origin).port, "8787");
  } finally {
    await runner.stop();
  }
  await assert.rejects(
    fetch(origin + "/api/snapshot", {
      headers: { cookie },
      signal: AbortSignal.timeout(500),
    }),
  );
});

test("local monitor rejects unrelated origins, invalid commands and unrecorded or escaped log access", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const runner = await webRunner();
  try {
    const { run } = await seedWebEvidence(runner);
    const { origin, cookie } = await runner.access();
    const headers = { cookie, origin, "content-type": "application/json" };
    const api = (path: string) => fetch(origin + path, { headers });
    for (const unrelated of ["https://unrelated.example", "null"]) {
      assert.equal(
        (
          await fetch(origin + "/api/snapshot", {
            headers: { cookie, origin: unrelated },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(origin + "/api/commands", {
            method: "POST",
            headers: { ...headers, origin: unrelated },
            body: JSON.stringify({ kind: "pause", target: "fixture" }),
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await fetch(origin + "/api/commands", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      await requestWithHost(origin + "/api/snapshot", "unrelated.example"),
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ kind: "shell", target: "fixture" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(origin + "/api/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ kind: "pause", target: "unknown" }),
        })
      ).status,
      404,
    );
    await runner.store.registerProject("unselected");
    assert.deepEqual(
      (await (await api("/api/snapshot")).json()).projects.map(
        (project: { id: string }) => project.id,
      ),
      ["fixture"],
    );
    const detail = await (await api(`/api/runs/${run.id}`)).json();
    assert.equal(detail.sessions[0].sessionId, "session-123");
    const logPath = `/api/runs/${run.id}/log?log=${encodeURIComponent(detail.logs[0].id)}`;
    const log = await (await api(logPath)).json();
    assert.deepEqual(log.lines, [
      "message: Recorded agent output",
      "validation failed",
    ]);
    assert.equal(
      (await api(`/api/runs/${run.id}/log?log=/etc/passwd`)).status,
      404,
    );
    const outside = join(runner.directory, "outside.log");
    await writeFile(outside, "private outside evidence");
    const link = join(runner.config.stateDirectory, "escape.log");
    await symlink(outside, link);
    await runner.store.saveInvocation({ ...detail.sessions[0], log: link });
    assert.equal((await api(logPath)).status, 403);
    assert.equal(
      (await api("/api/snapshot")).headers.get("cache-control"),
      "no-store",
    );
  } finally {
    await runner.stop();
  }
});

test("run keeps workflows available when the requested port is occupied and supports disabling the server", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const port = await unusedPort();
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(port, "127.0.0.1", done));
  try {
    for (const flags of [
      ["--web-port", String(port)],
      ["--no-web", "--web-port", String(port)],
    ]) {
      const runner = await webRunner({ flags });
      try {
        if (!flags.includes("--no-web"))
          await waitFor(async () => runner.output().includes("already in use"));
        assert.doesNotMatch(runner.output(), /Web monitor: http/);
        assert.equal(runner.child.exitCode, null);
        const id = await runner.store.request("pause", "fixture");
        await waitFor(async () =>
          (await runner.store.commands()).some(
            (command) => command.id === id && command.status === "success",
          ),
        );
      } finally {
        await runner.stop();
      }
    }
  } finally {
    await new Promise<void>((done) => occupied.close(() => done()));
  }
});

test("web child crashes do not stop the runner and parent loss closes local browser access", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  for (const killParent of [false, true]) {
    const runner = await webRunner();
    try {
      const { origin, cookie } = await runner.access();
      if (killParent) {
        runner.child.kill("SIGKILL");
        await runner.closed;
      } else {
        const pid = Number(
          execFileSync("pgrep", ["-P", String(runner.child.pid)], {
            encoding: "utf8",
          }).trim(),
        );
        assert.ok(Number.isInteger(pid) && pid > 0);
        process.kill(pid, "SIGKILL");
        await waitFor(async () => runner.output().includes("server exited"));
        const id = await runner.store.request("pause", "fixture");
        await waitFor(async () =>
          (await runner.store.commands()).some(
            (command) => command.id === id && command.status === "success",
          ),
        );
      }
      await waitFor(async () => {
        try {
          await fetch(origin + "/api/snapshot", {
            headers: { cookie },
            signal: AbortSignal.timeout(500),
          });
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      await runner.stop();
    }
  }
});

test("runner remains authoritative for all operator action kinds and records rejections", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const runner = await webRunner();
  try {
    const { run } = await seedWebEvidence(runner);
    await runner.store.patchRun(run.id, { outcome: "completed" });
    const { origin, cookie } = await runner.access();
    for (const kind of [
      "resume",
      "reload",
      "stop",
      "retry",
      "retry-refresh",
      "recover",
    ] as const) {
      const target =
        kind === "reload" ? "" : kind === "resume" ? "fixture" : run.id;
      const response = await fetch(origin + "/api/commands", {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ kind, target }),
      });
      assert.equal(response.status, 202);
      const { id } = await response.json();
      let status: string | undefined;
      await waitFor(async () => {
        const snapshot = await (
          await fetch(origin + "/api/snapshot", { headers: { cookie } })
        ).json();
        status = snapshot.commands.find(
          (command: { id: string }) => command.id === id,
        )?.status;
        return !!status && status !== "pending";
      });
      assert.equal(
        status,
        ["retry", "retry-refresh", "recover"].includes(kind)
          ? "failed"
          : "success",
        kind,
      );
    }
  } finally {
    await runner.stop();
  }
});

test("controlled workflow completes despite web startup failure or a crash during agent work", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const occupied = createServer();
  const port = await unusedPort();
  await new Promise<void>((done) => occupied.listen(port, "127.0.0.1", done));
  try {
    for (const crash of [false, true]) {
      const runner = await webRunner({
        controlledWorkflow: true,
        ...(crash ? {} : { flags: ["--web-port", String(port)] }),
      });
      try {
        await waitFor(async () =>
          (await runner.status()).runs.some(
            (run) => run.phase === "implementation",
          ),
        );
        if (crash) {
          await runner.access();
          const pid = Number(
            execFileSync("pgrep", ["-P", String(runner.child.pid)], {
              encoding: "utf8",
            }).trim(),
          );
          process.kill(pid, "SIGKILL");
          await waitFor(async () => runner.output().includes("server exited"));
        } else
          await waitFor(async () => runner.output().includes("already in use"));
        await writeFile(runner.gate, "continue");
        await waitFor(async () =>
          (await runner.status()).runs.some(
            (run) => run.outcome === "completed",
          ),
        );
      } finally {
        await runner.stop();
      }
    }
  } finally {
    await new Promise<void>((done) => occupied.close(() => done()));
  }
});

test("web configuration shows accepted runner settings across reloads and rejects unauthenticated reads", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const runner = await webRunner();
  try {
    const { origin, cookie } = await runner.access();
    const readConfig = async () => {
      const response = await fetch(origin + "/api/configuration", {
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await fetch(origin + "/api/configuration")).status, 401);
    const initial = await readConfig();
    assert.equal(
      initial.projects[0].checkout,
      runner.config.projects[0]!.checkout,
    );
    assert.equal("databaseUrl" in initial, false);
    const candidate = {
      ...runner.config,
      projectBase: { pollIntervalMs: 12345 },
      projects: runner.config.projects.map(
        ({ pollIntervalMs: _pollInterval, ...project }) => ({
          ...project,
          inheritProjectBase: true,
        }),
      ),
    };
    const reload = async () => {
      const response = await fetch(origin + "/api/commands", {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ kind: "reload", target: "" }),
      });
      const { id } = await response.json();
      let status: string | undefined;
      await waitFor(async () => {
        const snapshot = await (
          await fetch(origin + "/api/snapshot", { headers: { cookie } })
        ).json();
        status = snapshot.commands.find(
          (command: { id: string }) => command.id === id,
        )?.status;
        return status !== undefined && status !== "pending";
      });
      return status;
    };
    await writeFile(runner.configPath, JSON.stringify(candidate));
    assert.equal(await reload(), "success");
    assert.equal((await readConfig()).projects[0].pollIntervalMs, 12345);
    await writeFile(
      runner.configPath,
      JSON.stringify({
        ...candidate,
        projectBase: {
          ...candidate.projectBase,
          hosting: { origin: "https://changed.invalid" },
        },
        projects: candidate.projects.map(
          ({ hosting: { origin: _origin, ...hosting }, ...project }) => ({
            ...project,
            hosting,
          }),
        ),
      }),
    );
    assert.equal(await reload(), "failed");
    assert.equal(
      (await readConfig()).projects[0].hosting.origin,
      initial.projects[0].hosting.origin,
    );
    await writeFile(runner.configPath, "invalid JSON");
    assert.equal(await reload(), "failed");
    assert.equal((await readConfig()).projects[0].pollIntervalMs, 12345);
  } finally {
    await runner.stop();
  }
});

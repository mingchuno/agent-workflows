import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSchema } from "../src/config.js";
import { command } from "../src/runtime/process.js";
export async function repository() {
  const root = await mkdtemp(join(tmpdir(), "agent-workflows-test-"));
  const git = (...args: string[]) => command("git", args, { cwd: root });
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.com");
  await writeFile(join(root, "file.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  const remote = root + "-remote";
  await git("clone", "--bare", root, remote);
  await git("remote", "add", "origin", remote);
  const project = projectSchema.parse({
    id: "fixture",
    checkout: root,
    hosting: {
      provider: "github",
      origin: "https://github.com",
      repository: "a/b",
      tokenEnv: "FIXTURE_TOKEN",
    },
    agent: { provider: "codex" },
    gitIdentity: { name: "Agent", email: "agent@example.com" },
  });
  return { root, git, project };
}

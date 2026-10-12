import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export function createAgents() {
  const agent = {
    async validate(profile) {
      return {
        provider: profile.provider,
        model: "fixture",
        reasoningEffort: "unknown",
        context: "unknown",
        contextWindowTokens: "unknown",
      };
    },
    async invoke(invocation) {
      await invocation.session(invocation.resumeSessionId ?? "fixture-session");
      await invocation.event({
        type: "message",
        text: `Fixture ${invocation.step}`,
      });
      if (["implementation", "fix"].includes(invocation.step)) {
        while (!(await exists(process.env.AW_WEB_TEST_GATE))) {
          invocation.signal.throwIfAborted();
          await setTimeout(25, undefined, { signal: invocation.signal });
        }
        await writeFile(
          join(invocation.cwd, "implemented.txt"),
          "fixture implementation\n",
        );
        return JSON.stringify({
          summary: "Fixture implemented",
          validation: [],
          limitations: [],
        });
      }
      if (invocation.step === "publication")
        return JSON.stringify({
          commitMessage: "feat: fixture implementation",
          title: "Fixture change",
          description: "Fixture completed",
        });
      return JSON.stringify({
        complete: true,
        summary: "Fixture reviewed",
        findings: [],
        limitations: [],
      });
    },
  };
  return { codex: agent, copilot: agent };
}
export function createHosting() {
  let change;
  const issue = async () => ({
    id: "1",
    number: 1,
    title: await readFile(process.env.AW_WEB_TEST_ISSUE, "utf8"),
    body: "Fixture task",
    url: "https://fixture.invalid/1",
    labels: ["ready-for-agent"],
    open: true,
  });
  return {
    identity: "https://fixture.invalid/a/b",
    listIssues: async () => [await issue()],
    getIssue: issue,
    listChanges: async () => [],
    findChange: async () => change,
    async createChange(input) {
      if (await exists(process.env.AW_WEB_TEST_PUBLICATION_FAILURE))
        throw new Error("Fixture publication unavailable");
      change = { id: 1, url: "https://fixture.invalid/pr/1", head: input.head };
      return change;
    },
    head: async (request) => request.head,
    publishReview: async () => {},
  };
}

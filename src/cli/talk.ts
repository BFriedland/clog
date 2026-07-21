import { spawn } from "node:child_process";

import { select } from "@inquirer/prompts";
import { Command } from "commander";

import { listConversations } from "../db/index.js";
import { isUnsummarized } from "../models/conversation.js";
import { UsageError } from "../utils/errors.js";

type TalkClient = "claude" | "codex";

interface TalkClientConfig {
  label: string;
  executable: string;
}

const CLIENT_CONFIG: Record<TalkClient, TalkClientConfig> = {
  claude: {
    label: "Claude Code",
    executable: "claude",
  },
  codex: {
    label: "Codex CLI",
    executable: "codex",
  },
};

export function buildTalkCommand(): Command {
  return new Command("talk")
    .description("Open an MCP-capable agent in this terminal for clog work")
    .argument("[client]", "claude or codex")
    .action(async (clientInput: string | undefined) => {
      await runAgentSession(clientInput, "talk");
    });
}

export function buildSummarizeCommand(): Command {
  return new Command("summarize")
    .description(
      "Open an MCP-capable agent and ask it to summarize unsummarized saved conversations",
    )
    .argument("[client]", "claude or codex")
    .action(async (clientInput: string | undefined) => {
      await runAgentSession(clientInput, "summarize");
    });
}

async function runAgentSession(
  clientInput: string | undefined,
  framing: "talk" | "summarize",
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      "clog talk and clog summarize must be run from an interactive terminal.",
    );
  }

  const client = await resolveTalkClient(clientInput);
  const state = await gatherClogState();
  const initialPrompt = framing === "summarize"
    ? buildSummarizePrompt(state)
    : buildTalkPrompt(state);

  await launchAgent(client, initialPrompt);
}

async function resolveTalkClient(input: string | undefined): Promise<TalkClient> {
  if (input != null) {
    return parseClient(input);
  }

  return select<TalkClient>({
    message: "Which agent should open?",
    choices: (Object.keys(CLIENT_CONFIG) as TalkClient[]).map((value) => ({
      value,
      name: CLIENT_CONFIG[value].label,
    })),
  });
}

function parseClient(input: string): TalkClient {
  const normalized = input.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex") {
    return normalized;
  }
  throw new UsageError(
    `Unknown agent "${input}". Use "claude" or "codex".`,
  );
}

interface ClogState {
  totalSaved: number;
  unsummarizedSaved: number;
  unsummarizedProjects: string[];
}

async function gatherClogState(): Promise<ClogState> {
  const saved = await listConversations({
    states: ["saved"],
    origin: "local",
  });

  const unsummarized = saved.filter(isUnsummarized);
  const projectsSet = new Set<string>();
  for (const conversation of unsummarized) {
    if (conversation.projectName) {
      projectsSet.add(conversation.projectName);
    }
  }

  return {
    totalSaved: saved.length,
    unsummarizedSaved: unsummarized.length,
    unsummarizedProjects: Array.from(projectsSet).sort(),
  };
}

function buildTalkPrompt(state: ClogState): string {
  return [
    "You have been opened by clog's `talk` command. clog is a local",
    "knowledge base of the user's AI coding-agent conversations. You have",
    "MCP tools available under the `clog_` prefix.",
    "",
    "Current clog state:",
    `- Total saved conversations: ${state.totalSaved}`,
    `- Conversations without structured summaries: ${state.unsummarizedSaved}`,
    state.unsummarizedProjects.length > 0
      ? `- Projects with unsummarized work: ${formatProjectList(state.unsummarizedProjects)}`
      : "",
    "",
    "Ask the user whether they would like to:",
    state.unsummarizedSaved > 0
      ? `  1. Summarize the ${state.unsummarizedSaved} conversation(s) without structured summaries. Explain briefly that summaries are optional metadata that help future agents scan the library, filter by topic/outcome/tools, and choose which transcripts to read. If picked, read \`summarization_guide\` first, then list candidates with \`list_conversations({ origin: "local" })\` so imported read-only rows stay out of the batch, then call \`get_conversation\` and \`update_conversation\` per conversation.`
      : "",
    state.unsummarizedSaved > 0
      ? "  2. Explore their existing saved conversations. If picked, call `analysis_suggestions` for opinionated starting points, or follow the user's lead."
      : "  1. Explore their saved conversations. If picked, call `analysis_suggestions` for opinionated starting points, or follow the user's lead.",
    state.unsummarizedSaved > 0
      ? "  3. Do something else they have in mind."
      : "  2. Do something else they have in mind.",
    "",
    state.unsummarizedSaved > 0
      ? "Summarization is useful but not required — do not pre-load the summarization guide before the user picks. Do not start work before checking with them. Keep the opening short."
      : "Do not start work before checking with the user. Keep the opening short.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSummarizePrompt(state: ClogState): string {
  return [
    "You have been opened by clog's `summarize` command. Your job is to write structured summaries for saved conversations that do not have them.",
    "",
    "Current clog state:",
    `- Total saved conversations: ${state.totalSaved}`,
    `- Conversations without structured summaries: ${state.unsummarizedSaved}`,
    state.unsummarizedProjects.length > 0
      ? `- Projects with unsummarized work: ${formatProjectList(state.unsummarizedProjects)}`
      : "",
    "",
    "Start by calling the `summarization_guide` MCP tool. It explains the extraction shape and quality bar. Then:",
    "",
    state.unsummarizedSaved > 0
      ? `1. Explain briefly that summaries are recommended because they help future agents scan the library, group conversations by topic/outcome/tools, and avoid loading irrelevant transcripts. Then ask the user to confirm whether they want you to summarize the ${state.unsummarizedSaved} conversation(s) without structured summaries now, and on what scope (all, a specific project, a count like "the most recent 10"). Wait for their answer before starting — summarizing requires reading transcripts and costs time and tokens. When you do begin, list candidates with \`list_conversations({ origin: "local" })\` so imported read-only rows are excluded from the batch, then call \`get_conversation\` and \`update_conversation\` per conversation.`
      : "1. Tell the user there are no conversations without structured summaries and ask whether they want to explore their existing summaries instead.",
    "2. After each conversation you summarize, report progress.",
    "3. When done, tell the user how many you summarized and which projects you covered. Offer to help them explore (`analysis_suggestions` is available).",
    "",
    "Do not summarize conversations with `summaryKind: \"curated\"`. Imported conversations are read-only and `update_conversation` will reject them — filter them out with `origin: \"local\"` rather than discovering this at write time.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatProjectList(projects: string[]): string {
  const limit = 5;
  if (projects.length <= limit) {
    return projects.join(", ");
  }
  return `${projects.slice(0, limit).join(", ")} (+${projects.length - limit} more)`;
}

async function launchAgent(
  client: TalkClient,
  initialPrompt: string,
): Promise<void> {
  const { executable, label } = CLIENT_CONFIG[client];
  process.stdout.write(`Opening ${label}...\n`);

  await new Promise<void>((resolve, reject) => {
    // Pass the initial prompt as a single positional argument. Both Claude
    // Code and Codex CLI accept "<prompt>" as the starting message for an
    // interactive session.
    const child = spawn(executable, [initialPrompt], {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      // The user may have exited the agent with a non-zero code (e.g., ctrl-C).
      // Treat any exit as a normal end of session.
      resolve();
    });
  });
}

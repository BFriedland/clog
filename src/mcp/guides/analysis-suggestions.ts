export interface AnalysisSuggestion {
  id: string;
  name: string;
  description: string;
  audience: "solo" | "team" | "both";
  suggestedPrompt: string;
}

export const ANALYSIS_SUGGESTIONS_VERSION = 2;

// A small, opinionated set of analyses derived from early user
// feedback. clog's job is to suggest what is worth looking for; the agent
// runs the analysis against the existing MCP tools.
const LIST_PAGING_GUIDANCE =
  "When a list response has hasMore: true, continue with offset: nextOffset and the same limit until you have enough rows for the analysis.";

export const ANALYSIS_SUGGESTIONS: AnalysisSuggestion[] = [
  {
    id: "intro_prompt_quality",
    name: "Intro prompt quality",
    description:
      "Review the user's opening messages across conversations to surface patterns in how they frame work — what they include, what they leave for the agent to infer, and where ambiguity caused rework later.",
    audience: "both",
    suggestedPrompt:
      `Use clog_list_saved with a reasonable limit to gather saved conversations. ${LIST_PAGING_GUIDANCE} For a sample of them, call clog_get with head=2 to see the user's opening messages. Then look across the openings for patterns: missing constraints, unstated goals, ambiguous success criteria. Report 3–5 concrete suggestions the user could apply to future intro prompts, citing the conversation ids you drew them from.`,
  },
  {
    id: "assumption_oversights",
    name: "Missed assumptions",
    description:
      "Find conversations where a wrong assumption surfaced late and could have been avoided by saying something at the outset.",
    audience: "both",
    suggestedPrompt:
      `Use clog_list_saved with a reasonable limit to inspect saved conversation extractions. ${LIST_PAGING_GUIDANCE} Search the extractions' notableMoments for entries that hint at late discoveries, wrong premises, or unstated assumptions. For 3–5 of the strongest hits, read enough of the conversation to confirm what the missed assumption was and how it could have been declared up front. Summarize the patterns and recommend prompt boundaries that would have caught them.`,
  },
  {
    id: "iteration_outliers",
    name: "Iteration outliers",
    description:
      "Find conversations that took unusually many turns to converge — useful for spotting workflows where a small upfront change could prevent a lot of back-and-forth.",
    audience: "both",
    suggestedPrompt:
      `List saved conversations with clog_list_saved and a reasonable limit. ${LIST_PAGING_GUIDANCE} For each candidate, note totalMessages (from clog_get) relative to the project's typical message count. Identify outliers — conversations far above the project's median. Read enough of each outlier to characterize what made it long. Suggest specific workflow improvements.`,
  },
  {
    id: "abandoned_tasks_by_project",
    name: "Abandoned tasks by project",
    description:
      "Surface unfinished work per project so the user can decide whether to revisit it.",
    audience: "both",
    suggestedPrompt:
      `List saved conversations with clog_list_saved and a reasonable limit. ${LIST_PAGING_GUIDANCE} Filter to those with \`extraction.outcome\` of \`abandoned\` or \`partial\`. Group by project. For each project, list the conversations and their summaries. Highlight any patterns (e.g., the same feature attempted multiple times).`,
  },
  {
    id: "tool_usage_patterns",
    name: "Tool usage patterns",
    description:
      "Show which tools dominate the user's workflow — useful for spotting reliance, gaps, or unusual habits.",
    audience: "both",
    suggestedPrompt:
      `Use clog_list_saved with a reasonable limit to inspect saved conversation extractions. ${LIST_PAGING_GUIDANCE} Aggregate \`extraction.toolsUsed\` across saved conversations. Report the top tools by frequency and any tools that show up in only a few conversations but might be more broadly useful. Note any conversations that used a notably different toolset than the user's norm.`,
  },
  {
    id: "noise_patterns",
    name: "Noise patterns",
    description:
      "Find conversations the summarizer flagged as having no substantive content — accidental opens, harness configurations with no real prompts, sessions interrupted before any work — and surface patterns across projects or time. Useful for spotting workflow friction (e.g., a setup that keeps getting accidentally triggered) even though individual noise rows aren't interesting on their own.",
    audience: "both",
    suggestedPrompt:
      `List saved conversations with clog_list_saved and a reasonable limit. ${LIST_PAGING_GUIDANCE} Filter to those with \`extraction.outcome\` of \`noise\`. Group by project and by week. Report counts, surface any project that accumulates noise faster than others, and read 1-2 examples per cluster to characterize what's causing them. Recommend specific workflow changes if patterns suggest a fixable cause (e.g., always-mistakenly-opened tool, harness config done in conversation that should be done elsewhere). Do not recommend deleting the noise rows — they are evidence.`,
  },
  {
    id: "team_outliers",
    name: "Team outliers",
    description:
      "When sharing a clog repo with a team, surface conversations or authors whose patterns differ noticeably from the rest — even if the reason isn't clear yet.",
    audience: "team",
    suggestedPrompt:
      `List saved conversations with origin remote and a reasonable limit. ${LIST_PAGING_GUIDANCE} Group by author. For each author, summarize average totalMessages, common outcomes, and dominant tools. Highlight authors whose pattern differs from the group median. Do not speculate on why; just surface the outliers so the user can investigate.`,
  },
];

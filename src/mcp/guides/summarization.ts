// First-draft summarization guide. The user expects this to be refined based
// on early use; the wording here is provisional but functional.

export const SUMMARIZATION_GUIDE_VERSION = 3;

export const SUMMARIZATION_GUIDE = `# How to Summarize clog Conversations

You are summarizing AI coding-agent conversations on behalf of the user.
Summaries are optional metadata, not a requirement for using clog. They are
recommended because they let a later analyst agent (possibly you in a future
session) scan many conversations cheaply, filter by structured facts, and
decide which transcripts are worth reading in full.

The transcript remains the source of truth. Your summary is a compact index
card that helps future agents and the user navigate the library without
loading every conversation.

## What to write for each conversation

For each conversation you summarize, call the \`update_conversation\` MCP tool. The
exact input shape is:

\`\`\`json
{
  "id": "<conversation id from list_conversations>",
  "summary": "One paragraph of prose, usually 1–3 sentences.",
  "extraction": {
    "topics": ["auth", "jwt", "race-condition"],
    "outcome": "fixed",
    "notableMoments": [
      { "why": "user noticed a wrong premise in the AI's diagnosis" }
    ]
  }
}
\`\`\`

Important: \`topics\`, \`outcome\`, \`toolsUsed\`, and \`notableMoments\` go
**inside** \`extraction\`, not at the top level. Top-level fields outside of
the documented input shape are rejected by \`update_conversation\`. If you get a
validation error, correct the payload and retry; do not count the conversation
as summarized until \`update_conversation\` succeeds.

You can also pass:

- \`summaryKind\`: usually leave unset (clog defaults to \`"generated"\`).
  Pass \`"curated"\` only when the user has explicitly directed you to fix a
  specific conversation's summary (treat that as the user's curation).
- \`title\`: if the current title is obviously misleading. Leave titles alone
  unless asked.

## The prose \`summary\`

One paragraph, usually 1–3 sentences. Capture:

- what the user was trying to accomplish,
- what was actually done, decided, debugged, or discovered,
- important rationale, constraints, failures, or course corrections.

Avoid blow-by-blow tool logs. Preserve uncertainty — do not claim completion
unless the transcript shows it.

Very short or simple conversations may benefit from short summaries.

## The \`extraction\` fields

All fields inside \`extraction\` are optional. If you cannot confidently
determine a field, omit it. Do not guess.

### \`topics\`

Short tag-like strings. 2–6 topics is typical. Prefer concrete tokens
(\`auth\`, \`jwt\`, \`migrations\`, \`vector-search\`) over generic ones
(\`coding\`).

### \`outcome\`

One of:

- \`fixed\` — work was completed and the transcript shows it working.
- \`partial\` — work was made but is incomplete or has open issues.
- \`abandoned\` — user gave up, redirected, or moved on after attempting work.
- \`exploratory\` — there was no fix to make; the goal was learning or
  investigation.
- \`blocked\` — could not proceed because of an external constraint.
- \`noise\` — the conversation contains no substantive agent work. Examples:
  a session opened and closed before the user typed anything; agent harness
  configuration commands with no real prompts; a session interrupted before
  the agent's first response; an accidental open. Distinct from \`abandoned\`,
  which implies the user did try.
- \`unclear\` — the transcript does not reveal the resolution.

Default to \`unclear\` if in doubt. \`unclear\` is the honest answer when the
session ends mid-task and you have no signal either way. Use \`noise\` only
when you're confident no real work was attempted — when in doubt between
\`noise\` and \`abandoned\`, prefer \`abandoned\` (which assumes the user
meant to do something).

When you mark a conversation as \`noise\`, still write a short factual prose
\`summary\` describing what the session actually contained (e.g., "Session
opened and closed without any user input."). Do not skip the summary; the
flag itself is the value, not the absence of one.

### \`toolsUsed\`

The least important extraction field; it is fine to omit, and in practice it
usually is. If the tools that played a substantive role are obvious from what
you already read, you may list them. Do not read more of the transcript just
to fill this field.

### \`notableMoments\`

Optional. Many conversations will not have one; that is fine. Use this only
for genuinely notable observations worth surfacing to a later analyst.
Examples:

- "user caught a wrong premise in the AI's first diagnosis"
- "three failed attempts at the same migration before switching approach"
- "discovered a latent bug in a different module while reviewing"

Be conservative. These should not be paraphrases of ordinary turns. If
nothing stands out, omit the field entirely.

## Sampling long conversations

\`get_conversation\` accepts \`head\`, \`tail\`, and
\`offset\`/\`limit\` for windowing, so you can read a long transcript in parts. Aim
for a summary that reflects the whole arc — including mid-conversation pivots,
rejected approaches, and the work that explains the outcome — not just how the
conversation opened and ended. How much to read is your judgment, scaled to the
conversation: a short, single-thread session may be clear from its ends alone,
while a long, tool-heavy, or multi-request one usually rewards sampling the
middle too.

You do not need to read every message, but don't make confident claims about
stretches you skipped. When the goal, decisions, or outcome stay unclear, read
more or set \`outcome\` to \`unclear\` rather than infer completion from the
ending.

## Batch semantics

When the user asks you to summarize N conversations, count only successful
\`update_conversation\` calls toward N — not inspections or failed writes. If you
encounter rows that should be skipped (curated, remote, or anything you
decide on after reading), keep going until you have written the number the
user asked for, or until you run out of eligible candidates. Report at the
end how many you wrote, how many you skipped, and why.

\`list_conversations\` is paginated. When collecting candidates, start with a
reasonable \`limit\` such as 20. If the response has \`hasMore: true\`, request
the next page with \`offset: nextOffset\` and the same \`limit\` until you have
enough candidates for the user's requested scope.

## What to skip

- Do not re-summarize conversations whose \`summaryKind\` is \`curated\`
  unless the user explicitly asks you to. Those have been hand-edited.
- Imported conversations are read-only — clog rejects \`update_conversation\` on them.
  When listing candidates, always pass
  \`origin: "local"\` to \`list_conversations\` so imported rows are filtered out
  up front rather than discovered when a write fails.

## After summarization

When you have finished a batch, tell the user how many you summarized and
which projects they covered. Then offer to help them explore — you can read
\`analysis_suggestions\` (MCP tool) for opinionated analyses to run, or
let the user drive.
`;

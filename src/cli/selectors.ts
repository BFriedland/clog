import type { ConversationMeta } from "../models/conversation.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { isValidSourceKey, parseSourceQualifiedId } from "../utils/source-keys.js";

export interface SelectorResolutionOptions {
  commandName: string;
  tokens: string[];
  idCandidates: ConversationMeta[];
  projectCandidates: ConversationMeta[];
  projectSelectionFilter?: (conversation: ConversationMeta) => boolean;
  rejectExplicitProjectSelector?: boolean;
  rejectExplicitProjectSelectorHint?: string;
}

export function resolveConversationSelectors(
  options: SelectorResolutionOptions,
): ConversationMeta[] {
  const resolved: ConversationMeta[] = [];
  const seen = new Set<string>();

  for (const token of options.tokens) {
    const selection = resolveSelectorToken(token, options);
    for (const conversation of selection) {
      if (seen.has(conversation.id)) {
        continue;
      }
      seen.add(conversation.id);
      resolved.push(conversation);
    }
  }

  return resolved;
}

function resolveSelectorToken(
  token: string,
  options: SelectorResolutionOptions,
): ConversationMeta[] {
  const explicitProjectName = parseExplicitProjectSelector(token);
  if (explicitProjectName != null) {
    if (options.rejectExplicitProjectSelector) {
      const hint = options.rejectExplicitProjectSelectorHint
        ? ` ${options.rejectExplicitProjectSelectorHint}`
        : "";
      throw new UsageError(
        `${options.commandName} does not accept project selectors like "${token}".${hint}`,
      );
    }

    return resolveProjectSelector(token, explicitProjectName, options);
  }

  const idMatches = findConversationIdMatches(options.idCandidates, token);
  const projectMatches = findProjectMatches(options.projectCandidates, token);

  if (idMatches.length > 0 && projectMatches.length > 0) {
    throw new UsageError(
      `Selector "${token}" is ambiguous: it matches both a conversation ID and project "${token}". Use a fuller/source-qualified conversation ID or "project:${token}" to disambiguate.`,
    );
  }

  if (projectMatches.length > 0) {
    return filterProjectMatches(projectMatches, options);
  }

  const trimmed = token.trim();
  if (!trimmed.includes("@") && trimmed.length > 0 && trimmed.length < 4) {
    throw new UsageError(
      `Conversation IDs must use at least 4 characters, got "${token}".`,
    );
  }

  if (idMatches.length > 0) {
    if (idMatches.length > 1) {
      throw new UsageError(buildAmbiguousConversationIdMessage(token, idMatches));
    }
    return [idMatches[0]];
  }

  const noMatchLabel = looksLikeConversationSelector(token) ? "conversation" : "conversation or project";
  throw new ClogError(
    `No ${noMatchLabel} matches "${token}". Run 'clog list' or 'clog status' to inspect available conversations and projects.`,
  );
}

function parseExplicitProjectSelector(token: string): string | null {
  if (!token.startsWith("project:")) {
    return null;
  }

  const projectName = token.slice("project:".length).trim();
  if (projectName.length === 0) {
    throw new UsageError('Project selectors must use the form "project:<name>".');
  }

  return projectName;
}

function resolveProjectSelector(
  rawToken: string,
  projectName: string,
  options: SelectorResolutionOptions,
): ConversationMeta[] {
  const matches = findProjectMatches(options.projectCandidates, projectName);
  if (matches.length === 0) {
    throw new ClogError(
      `No project matches "${rawToken}". Run 'clog list --all' to inspect available projects.`,
    );
  }

  return filterProjectMatches(matches, options);
}

function filterProjectMatches(
  matches: ConversationMeta[],
  options: SelectorResolutionOptions,
): ConversationMeta[] {
  if (!options.projectSelectionFilter) {
    return matches;
  }

  return matches.filter(options.projectSelectionFilter);
}

function findConversationIdMatches(
  candidates: ConversationMeta[],
  token: string,
): ConversationMeta[] {
  const trimmed = token.trim();
  const parsed = parseSourceQualifiedId(trimmed);

  if (!parsed.ok) {
    throw new UsageError(
      `Invalid source-qualified conversation ID "${token}". Use "<prefix>@<source>".`,
    );
  }

  const prefix = parsed.value.prefix.toLowerCase();
  const source = parsed.value.source;

  if (source !== null) {
    // Explicit `prefix@source` syntax commits the token to the ID space, so
    // length / shape problems are reported instead of falling through.
    if (prefix.length < 4) {
      throw new UsageError(
        `Conversation IDs must use at least 4 characters, got "${token}".`,
      );
    }
  }

  return candidates.filter((conversation) => {
    if (source !== null && conversation.source !== source) {
      return false;
    }

    return conversation.id.toLowerCase().startsWith(prefix);
  });
}

function findProjectMatches(
  candidates: ConversationMeta[],
  token: string,
): ConversationMeta[] {
  return candidates.filter(
    (conversation) =>
      conversation.projectName != null &&
      conversation.projectName.toLowerCase() === token.trim().toLowerCase(),
  );
}

function buildAmbiguousConversationIdMessage(
  token: string,
  matches: ConversationMeta[],
): string {
  const rendered = matches
    .map((conversation) => `${conversation.id}@${conversation.source}`)
    .join("\n");
  return `Conversation ID "${token}" is ambiguous. Matches:\n${rendered}`;
}

function looksLikeConversationSelector(token: string): boolean {
  const parsed = parseSourceQualifiedId(token.trim());
  if (!parsed.ok) {
    return false;
  }

  return (
    /^[a-f0-9-]{4,}$/i.test(parsed.value.prefix) &&
    (parsed.value.source == null || isValidSourceKey(parsed.value.source))
  );
}

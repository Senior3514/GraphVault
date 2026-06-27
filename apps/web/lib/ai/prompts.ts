/**
 * Pure prompt-builders for the AI assistant.
 *
 * Each builder returns a `ChatMessage[]` array ready to send to any provider.
 * No network calls, no side effects - purely functional so they are trivially
 * testable. The system message establishes the privacy-respecting framing:
 * the model is told it is operating on the user's private notes and that it
 * must not fabricate external links.
 */

import type { AssistantAction, ChatMessage } from './types';

const SYSTEM_PROMPT =
  'You are a helpful assistant for a private Markdown notes app called GraphVault. ' +
  'The user will share content from their personal notes. ' +
  'Your responses should be concise, factual, and formatted in Markdown. ' +
  'Do not fabricate external URLs or references. ' +
  "Respect the user's privacy: do not repeat or summarize their data back unnecessarily.";

/**
 * Build the message array for a given action.
 *
 * @param action - The assistant action to perform.
 * @param noteContent - The content of the current note (may be empty).
 * @param relatedTitles - Optional list of note titles in the vault (for link/relation suggestions).
 */
export function buildPrompt(
  action: AssistantAction,
  noteContent: string,
  relatedTitles: string[] = [],
): ChatMessage[] {
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT };

  switch (action) {
    case 'summarize': {
      const user: ChatMessage = {
        role: 'user',
        content:
          'Please summarize the following note in 2-4 sentences, highlighting the key ideas:\n\n' +
          '```\n' +
          noteContent +
          '\n```',
      };
      return [system, user];
    }

    case 'find-related': {
      const titlesSection =
        relatedTitles.length > 0
          ? '\n\nOther notes in this vault (titles only):\n' +
            relatedTitles.map((t) => `- ${t}`).join('\n')
          : '';
      const user: ChatMessage = {
        role: 'user',
        content:
          'Given this note, which other notes (listed below) are most likely related to it? ' +
          'Explain briefly why (1 sentence each). If none seem related, say so.\n\n' +
          'Current note:\n```\n' +
          noteContent +
          '\n```' +
          titlesSection,
      };
      return [system, user];
    }

    case 'suggest-links': {
      const titlesSection =
        relatedTitles.length > 0
          ? '\n\nAvailable note titles:\n' + relatedTitles.map((t) => `- ${t}`).join('\n')
          : '';
      const user: ChatMessage = {
        role: 'user',
        content:
          'Review the following note and suggest `[[wikilink]]` references that could connect ' +
          'it to other notes in the vault. Only suggest links to notes that exist in the list below. ' +
          'Format your response as a Markdown list.\n\n' +
          'Current note:\n```\n' +
          noteContent +
          '\n```' +
          titlesSection,
      };
      return [system, user];
    }

    case 'suggest-tags': {
      const user: ChatMessage = {
        role: 'user',
        content:
          'Review the following note and suggest 3-6 relevant `#tags` that would help categorise it. ' +
          'Use lowercase, hyphen-separated words (e.g. `#machine-learning`, `#project-ideas`). ' +
          'Format as a Markdown list with a one-sentence explanation per tag.\n\n' +
          '```\n' +
          noteContent +
          '\n```',
      };
      return [system, user];
    }

    case 'outline': {
      const user: ChatMessage = {
        role: 'user',
        content:
          'Create a structured outline for the following note. ' +
          'Use Markdown headings (##, ###) and bullet points. ' +
          'Preserve the original intent; do not invent new content.\n\n' +
          '```\n' +
          noteContent +
          '\n```',
      };
      return [system, user];
    }

    default: {
      // TypeScript exhaustiveness guard.
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Build a human-readable description of what context will be sent to the
 * provider, so the user can confirm before sending.
 */
export function buildSendContext(
  action: AssistantAction,
  noteContent: string,
  relatedTitles: string[] = [],
): { description: string; text: string } {
  const chars = noteContent.length;
  const charsStr = chars.toLocaleString();

  switch (action) {
    case 'summarize':
      return {
        description: `current note (${charsStr} chars)`,
        text: noteContent,
      };
    case 'find-related':
    case 'suggest-links':
      return {
        description:
          `current note (${charsStr} chars)` +
          (relatedTitles.length > 0 ? ` + ${relatedTitles.length} note titles` : ''),
        text: noteContent,
      };
    case 'suggest-tags':
      return {
        description: `current note (${charsStr} chars)`,
        text: noteContent,
      };
    case 'outline':
      return {
        description: `current note (${charsStr} chars)`,
        text: noteContent,
      };
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${String(_exhaustive)}`);
    }
  }
}

/**
 * NAVO Requirement Intelligence Engine — Conversation Memory
 *
 * Maintains continuous requirement context across the chat session.
 * Resolves conversational pronouns ("that", "it", "them") and answers
 * natural language queries against the version history and audit trail.
 */

import { getDraftVersionHistory } from './version-tracker.js';

export async function answerVersionHistoryQuery(
  draftId: string,
  queryText: string
): Promise<string> {
  const versions = await getDraftVersionHistory(draftId);

  if (versions.length === 0) {
    return 'There are no previous versions recorded for this requirement yet. Current is Version 1.';
  }

  const lower = queryText.toLowerCase();

  // Query: "What was the original quantity?"
  if (/\b(original|initial|first)\s+(quantity|qty|count|number)\b/i.test(lower)) {
    // The oldest version is the last in desc order
    const originalVersion = versions[versions.length - 1];
    const origQty = originalVersion.snapshot.quantity;
    const currentVersion = versions[0];
    const currQty = currentVersion.snapshot.quantity;

    if (origQty !== undefined) {
      if (origQty === currQty) {
        return `The original quantity was **${origQty} units**, which remains unchanged.`;
      }
      return `The original quantity was **${origQty} units** in Version 1. You later updated it to **${currQty} units** in Version ${currentVersion.versionNumber}.`;
    }
    return `An initial quantity was not explicitly specified in the first version. Current quantity is **${currQty || 'not specified'}**.`;
  }

  // Query: "What was the previous/original budget?"
  if (/\b(original|previous|initial)\s+(budget|price|cost)\b/i.test(lower)) {
    const originalVersion = versions[versions.length - 1];
    const origBudget = originalVersion.snapshot.budget || originalVersion.snapshot.estimatedBudget;
    const currBudget = versions[0].snapshot.budget || versions[0].snapshot.estimatedBudget;
    const curr = versions[0].snapshot.currency || 'INR';

    if (origBudget) {
      return `The original budget was **${curr} ${origBudget}**. Current budget is **${curr} ${currBudget || 'not set'}**.`;
    }
    return `No budget was specified in the earlier version. Current budget is **${currBudget ? `${curr} ${currBudget}` : 'not set'}**.`;
  }

  // General "What changed?" / "Show history"
  const historyList = versions
    .slice(0, 5)
    .map((v) => `• **Version ${v.versionNumber}** (${new Date(v.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}): ${v.changeSummary}`)
    .join('\n');

  return `Here is the revision history for this requirement:\n\n${historyList}`;
}

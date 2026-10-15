import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  Loader2,
  MessageSquarePlus,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { copilotApi } from '../services/api';
import { RequirementIntakeChat } from '../components/requirement-intake/RequirementIntakeChat';
import { Button } from '../components/ui';
import type {
  CopilotAskResult,
  CopilotCitation,
  CopilotContext,
  CopilotContextType,
  CopilotConversationSummary,
  CopilotDescribe,
  CopilotMessage,
  CopilotProposedAction,
} from '../types';

type ActionState = 'PENDING' | 'EXECUTED' | 'DISMISSED' | 'FAILED';
type CopilotMode = 'general' | 'requirement-intake';

/**
 * One rendered turn. Assistant turns keep the answer's citations, the tools
 * that produced it and any action awaiting confirmation, so the whole audit
 * surface of a question stays visible on the thread.
 */
interface ThreadMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  createdAt: string;
  citations: CopilotCitation[];
  toolsUsed: string[];
  suggestedQuestions: string[];
  notAnswerable: boolean;
  isError?: boolean;
  proposal?: CopilotProposedAction;
  actionState?: ActionState;
  executedSummary?: string;
  executedHref?: string;
}

const CONTEXT_TYPES: CopilotContextType[] = [
  'REQUEST',
  'VENDOR',
  'RFQ',
  'QUOTE',
  'DEAL',
  'DEAL_ROOM',
  'PURCHASE_ORDER',
  'INVOICE',
];

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Show a relative-ish heading without pulling in a date library. */
function conversationHeading(conversation: CopilotConversationSummary): string {
  if (conversation.title) return conversation.title;
  if (conversation.contextLabel) return conversation.contextLabel;
  const first = new Date(conversation.updatedAt);
  if (Number.isNaN(first.getTime())) return 'Conversation';
  return `Conversation · ${first.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}`;
}

export const CopilotPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [describe, setDescribe] = useState<CopilotDescribe | null>(null);
  const [conversations, setConversations] = useState<CopilotConversationSummary[]>([]);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [confirmingActionId, setConfirmingActionId] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [mode, setMode] = useState<CopilotMode>('general');

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * The record the user opened the copilot from, if any. It is passed once per
   * conversation: the backend anchors the thread to it so a follow-up such as
   * "what about delivery?" resolves against the same record.
   */
  const context = useMemo<CopilotContext | undefined>(() => {
    const entityType = searchParams.get('entityType');
    const entityId = searchParams.get('entityId');
    if (!entityId || !entityType) return undefined;
    if (!CONTEXT_TYPES.includes(entityType as CopilotContextType)) return undefined;
    return {
      entityType: entityType as CopilotContextType,
      entityId,
      entityLabel: searchParams.get('entityLabel') ?? undefined,
    };
  }, [searchParams]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const loadConversations = useCallback(async () => {
    try {
      const response = await copilotApi.listConversations();
      setConversations(response.data.data ?? []);
    } catch {
      // A missing history list is not worth interrupting the user over.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await copilotApi.describe();
        if (!cancelled && response.data.data) setDescribe(response.data.data);
      } catch {
        // Fall back to a generic greeting rather than an empty screen.
      }
      await loadConversations();
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [loadConversations]);

  const openConversation = useCallback(async (id: string) => {
    setConversationId(id);
    setLoadingThread(true);
    try {
      const response = await copilotApi.getConversation(id);
      const conversation = response.data.data;
      if (!conversation) return;

      const pending = conversation.actions?.filter((action) => action.status === 'PROPOSED') ?? [];
      const next: ThreadMessage[] = conversation.messages.map((message: CopilotMessage) => ({
        id: message.id,
        role: message.role === 'USER' ? 'USER' : 'ASSISTANT',
        content: message.content,
        createdAt: message.createdAt,
        citations: (message.citations ?? []) as CopilotCitation[],
        toolsUsed: (message.toolCalls ?? []).map((call) => call.tool),
        suggestedQuestions: [],
        notAnswerable: false,
      }));

      // Re-attach a still-pending confirmation to the answer that proposed it.
      const lastAssistant = [...next].reverse().find((m) => m.role === 'ASSISTANT');
      const firstPending = pending[0];
      if (lastAssistant && firstPending) {
        lastAssistant.proposal = {
          actionId: firstPending.id,
          summary: firstPending.summary,
          details: [],
          warnings: [],
        };
        lastAssistant.actionState = 'PENDING';
      }

      setMessages(next);
    } catch (err) {
      toast.error((err as Error).message || 'Could not open that conversation');
      setMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  const startNewConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setInput('');
    // Drop the anchoring record so the next question is not silently about it.
    if (searchParams.has('entityId') || searchParams.has('entityType')) {
      searchParams.delete('entityId');
      searchParams.delete('entityType');
      searchParams.delete('entityLabel');
      setSearchParams(searchParams, { replace: true });
    }
    inputRef.current?.focus();
  }, [searchParams, setSearchParams]);

  const appendAnswer = useCallback((answer: CopilotAskResult) => {
    setConversationId(answer.conversationId);
    setMessages((prev) => [
      ...prev,
      {
        id: answer.assistantMessageId,
        role: 'ASSISTANT',
        content: answer.content,
        createdAt: new Date().toISOString(),
        citations: answer.citations ?? [],
        toolsUsed: answer.toolsUsed ?? [],
        suggestedQuestions: answer.suggestedQuestions ?? [],
        notAnswerable: answer.notAnswerable,
        proposal: answer.proposedAction,
        actionState: answer.proposedAction ? 'PENDING' : undefined,
      },
    ]);
  }, []);

  const send = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || sending) return;

      const optimistic: ThreadMessage = {
        id: `local-${Date.now()}`,
        role: 'USER',
        content: text,
        createdAt: new Date().toISOString(),
        citations: [],
        toolsUsed: [],
        suggestedQuestions: [],
        notAnswerable: false,
      };

      setMessages((prev) => [...prev, optimistic]);
      setInput('');
      setSending(true);

      try {
        const response = await copilotApi.ask(text, conversationId ?? undefined, context);
        if (!response.data.data) {
          throw new Error(response.data.error || 'The assistant could not answer');
        }
        appendAnswer(response.data.data);
        await loadConversations();
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: 'ASSISTANT',
            content: (err as Error).message || 'Something went wrong while answering.',
            createdAt: new Date().toISOString(),
            citations: [],
            toolsUsed: [],
            suggestedQuestions: [],
            notAnswerable: true,
            isError: true,
          },
        ]);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [appendAnswer, context, conversationId, loadConversations, sending]
  );

  const confirmAction = useCallback(
    async (messageId: string, actionId: string) => {
      setConfirmingActionId(actionId);
      try {
        const response = await copilotApi.confirmAction(actionId);
        const result = response.data.data;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  actionState: 'EXECUTED',
                  executedSummary: result?.summary,
                  executedHref: result?.href,
                }
              : message
          )
        );
        toast.success(result?.summary || 'Action completed');
        await loadConversations();
      } catch (err) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId ? { ...message, actionState: 'FAILED' } : message
          )
        );
        toast.error((err as Error).message || 'The action could not be completed');
      } finally {
        setConfirmingActionId(null);
      }
    },
    [loadConversations]
  );

  const dismissAction = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId ? { ...message, actionState: 'DISMISSED' } : message
      )
    );
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        await copilotApi.deleteConversation(id);
        if (id === conversationId) startNewConversation();
        await loadConversations();
      } catch (err) {
        toast.error((err as Error).message || 'Could not delete that conversation');
      }
    },
    [conversationId, loadConversations, startNewConversation]
  );

  const starterQuestions = describe?.suggestedQuestions ?? [];
  const lastAnswer = [...messages].reverse().find((message) => message.role === 'ASSISTANT');
  const followUps = lastAnswer?.suggestedQuestions.length ? lastAnswer.suggestedQuestions : [];

  return (
    <div className="card flex h-[calc(100vh-5.5rem)]">
      {/* Conversation history */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-stone-200 bg-stone-50/60 lg:flex">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold text-stone-900">Conversations</h2>
          <Button variant="ghost" size="sm" onClick={startNewConversation}>
            <MessageSquarePlus className="h-4 w-4" />
            New
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-4">
          {conversations.length === 0 ? (
            <p className="px-3 py-6 text-xs text-stone-500">
              Questions you ask will be listed here.
            </p>
          ) : (
            <ul className="space-y-1">
              {conversations.map((conversation) => {
                const active = conversation.id === conversationId;
                return (
                  <li key={conversation.id} className="group relative">
                    <button
                      onClick={() => void openConversation(conversation.id)}
                      className={`w-full rounded-lg px-3 py-2 pr-9 text-left text-sm transition-colors ${
                        active
                          ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-200'
                          : 'text-stone-700 hover:bg-white'
                      }`}
                    >
                      <span className="block truncate font-medium">
                        {conversationHeading(conversation)}
                      </span>
                      <span className="block text-xs text-stone-500">
                        {conversation._count?.messages ?? 0} messages ·{' '}
                        {formatTimestamp(conversation.updatedAt)}
                      </span>
                    </button>
                    <button
                      onClick={() => void deleteConversation(conversation.id)}
                      title="Delete conversation"
                      className="absolute right-2 top-2 rounded-md p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-100 hover:text-red-600 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
              <Bot className="h-4.5 w-4.5" />
            </span>
            <div>
              <h1 className="text-sm font-semibold text-stone-900">Ask Navo</h1>
              <p className="text-xs text-stone-500">
                Answers come from your own procurement records.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTools((prev) => !prev)}
              title="What this assistant can read"
            >
              <Database className="h-4 w-4" />
              {describe ? `${describe.tools.length} sources` : 'Sources'}
            </Button>
            <Button variant="secondary" size="sm" onClick={startNewConversation}>
              <MessageSquarePlus className="h-4 w-4" />
              New
            </Button>
          </div>
        </header>

        {showTools && describe && (
          <div className="border-b border-stone-200 bg-stone-50 px-5 py-3 text-xs text-stone-600">
            <p className="mb-2 font-medium text-stone-700">
              These are the only sources this assistant can read, at your current role. It
              cannot reach another company&apos;s records.
            </p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {describe.tools.map((tool) => (
                <li key={tool.name} className="truncate">
                  <span className="font-mono text-[11px] text-stone-800">{tool.name}</span>
                  <span className="ml-2 text-stone-500">{tool.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {context?.entityId && (
          <div className="flex items-center gap-2 border-b border-stone-200 bg-blue-50/60 px-5 py-2 text-xs text-blue-800">
            <Sparkles className="h-3.5 w-3.5" />
            <span>
              Anchored to {context.entityLabel ?? context.entityType}{' '}
              {context.entityId.slice(0, 8)} for this conversation.
            </span>
          </div>
        )}

        {/* Mode selector */}
        <div className="flex items-center gap-2 border-b border-stone-200 px-5 py-2">
          <span className="text-xs text-stone-500">Mode:</span>
          <div className="flex gap-1 bg-stone-100 rounded-lg p-1">
            <Button
              variant={mode === 'general' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setMode('general')}
              className="rounded-md"
            >
              <Bot className="h-3.5 w-3.5 mr-1" />
              Assistant
            </Button>
            <Button
              variant={mode === 'requirement-intake' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setMode('requirement-intake')}
              className="rounded-md"
            >
              <Sparkles className="h-3.5 w-3.5 mr-1" />
              Requirement Intake
            </Button>
          </div>
        </div>

        {/* Messages / Requirement Intake */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-6">
          {mode === 'requirement-intake' ? (
            <RequirementIntakeChat
              conversationId={conversationId ?? undefined}
              onRequestCreated={(requestId) => {
                toast.success(`Procurement request ${requestId.slice(0, 8)} created!`);
                // Optionally navigate to the request
              }}
              className="h-full w-full"
            />
          ) : (
            <>
              {loadingThread ? (
                <div className="flex h-full items-center justify-center text-stone-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : messages.length === 0 ? (
                <div className="mx-auto max-w-2xl">
                  <h2 className="text-lg font-semibold text-stone-900">What do you need to know?</h2>
                  <p className="mt-1 text-sm text-stone-600">
                    Navo answers from your company&apos;s own requests, suppliers, orders and
                    invoices. It will not guess, and it will not act without your confirmation.
                  </p>

                  {starterQuestions.length > 0 && (
                    <div className="mt-5 grid gap-2 sm:grid-cols-2">
                      {starterQuestions.map((question) => (
                        <button
                          key={question}
                          onClick={() => void send(question)}
                          className="card card-hover px-4 py-3 text-left text-sm text-stone-700"
                        >
                          {question}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mx-auto max-w-2xl space-y-6">
                  {messages.map((message) =>
                    message.role === 'USER' ? (
                      <div key={message.id} className="flex justify-end">
                        <div className="msg-bubble-buyer whitespace-pre-line">{message.content}</div>
                      </div>
                    ) : (
                      <div key={message.id}>
                        <div
                          className={`whitespace-pre-line text-sm leading-relaxed ${
                            message.isError ? 'text-red-700' : 'text-stone-800'
                          }`}
                        >
                          {message.content}
                        </div>

                        {message.notAnswerable && !message.isError && (
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-stone-500">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Not answered from stored data.
                          </p>
                        )}

                        {message.toolsUsed.length > 0 && (
                          <p className="mt-2 text-[11px] text-stone-400">
                            Answered from: {message.toolsUsed.join(', ')}
                          </p>
                        )}

                        {message.citations.length > 0 && (
                          <ul className="mt-3 space-y-1">
                            {message.citations.map((citation) => (
                              <li key={`${citation.entityType}-${citation.entityId}`}>
                                <button
                                  onClick={() => navigate(citation.href)}
                                  className="flex w-full items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-left text-xs text-stone-700 hover:border-stone-300 hover:bg-stone-50"
                                >
                                  <span className="badge-blue">{citation.entityType}</span>
                                  <span className="flex-1 truncate font-medium">{citation.label}</span>
                                  {citation.status && (
                                    <span className="text-[11px] text-stone-500">
                                      {citation.status.replace(/_/g, ' ').toLowerCase()}
                                    </span>
                                  )}
                                  <ChevronRight className="h-3.5 w-3.5 text-stone-400" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}

                        {message.proposal && (
                          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                              Waiting for your confirmation
                            </p>
                            <p className="mt-1 text-sm text-stone-800">{message.proposal.summary}</p>

                            {message.proposal.details.length > 0 && (
                              <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                                {message.proposal.details.map((detail) => (
                                  <div key={detail.field} className="flex gap-2">
                                    <dt className="text-stone-500">{detail.field}</dt>
                                    <dd className="flex-1 text-stone-800">{detail.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}

                            {message.proposal.warnings.length > 0 && (
                              <ul className="mt-3 space-y-1 text-xs text-amber-800">
                                {message.proposal.warnings.map((warning) => (
                                  <li key={warning} className="flex gap-1.5">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                    {warning}
                                  </li>
                                ))}
                              </ul>
                            )}

                            {message.actionState === 'PENDING' && (
                              <div className="mt-3 flex gap-2">
                                <Button
                                  size="sm"
                                  loading={confirmingActionId === message.proposal.actionId}
                                  onClick={() =>
                                    void confirmAction(message.id, message.proposal!.actionId)
                                  }
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Confirm
                                </Button>
                                <Button size="sm" variant="secondary" onClick={() => dismissAction(message.id)}>
                                  Cancel
                                </Button>
                              </div>
                            )}

                            {message.actionState === 'EXECUTED' && (
                              <div className="mt-3 flex items-center gap-2 text-xs text-emerald-700">
                                <CheckCircle2 className="h-4 w-4" />
                                <span>{message.executedSummary ?? 'Completed.'}</span>
                                {message.executedHref && (
                                  <button
                                    onClick={() => navigate(message.executedHref!)}
                                    className="font-medium text-blue-700 underline"
                                  >
                                    Open in Navo
                                  </button>
                                )}
                              </div>
                            )}

                            {(message.actionState === 'DISMISSED' ||
                              message.actionState === 'FAILED') && (
                              <p className="mt-3 text-xs text-stone-500">
                                {message.actionState === 'DISMISSED'
                                  ? 'Cancelled. Nothing was changed.'
                                  : 'This action could not be completed. Nothing was changed.'}
                              </p>
                            )}
                          </div>
                        )}

                        {message.suggestedQuestions.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {message.suggestedQuestions.map((question) => (
                              <button
                                key={question}
                                onClick={() => void send(question)}
                                disabled={sending}
                                className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-700 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                              >
                                {question}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  )}
                  <div ref={bottomRef} />
                </div>
              )}
            </>
          )}
        </div>

        {/* Composer - only in general mode */}
        {mode === 'general' && (
          <div className="border-t border-stone-200 px-5 py-4">
            {followUps.length > 0 && messages.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {followUps.map((question) => (
                <button
                  key={question}
                  onClick={() => void send(question)}
                  disabled={sending}
                  className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                >
                  {question}
                </button>
              ))}
            </div>
          )}

          <div className="chat-input-wrap">
            <textarea
              ref={inputRef}
              rows={2}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Ask about your requests, suppliers, orders or invoices…"
              className="w-full resize-none border-0 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-stone-400"
            />
            <div className="flex items-center justify-between px-3 pb-2">
              <span className="text-[11px] text-stone-400">Enter to send · Shift+Enter for a new line</span>
              <Button size="sm" onClick={() => void send(input)} loading={sending} disabled={!input.trim()}>
                <Send className="h-4 w-4" />
                Send
              </Button>
            </div>
          </div>

          <p className="mt-2 text-[11px] text-stone-400">
            Navo only reads records your account is allowed to see. Anything that changes a record
            is proposed first and runs only after you confirm it.
          </p>
        </div>
      )}
      </section>
    </div>
  );
};
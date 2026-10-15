import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, Loader2, Send, Sparkles } from 'lucide-react';
import { requirementIntakeApi } from '../../services/api';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import toast from 'react-hot-toast';
import type { RequirementDraftDetail, ClarificationQuestion } from '../../types';

type DraftState = 'empty' | 'loading' | 'ready' | 'confirming' | 'sourcing';

interface RequirementIntakeChatProps {
  conversationId?: string;
  onRequestCreated?: (requestId: string) => void;
  className?: string;
}

export const RequirementIntakeChat: React.FC<RequirementIntakeChatProps> = ({
  conversationId,
  onRequestCreated,
  className = '',
}) => {
  const [draft, setDraft] = useState<RequirementDraftDetail | null>(null);
  const [questions, setQuestions] = useState<ClarificationQuestion[]>([]);
  const [state, setState] = useState<DraftState>('loading');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const loadActiveDraft = useCallback(async () => {
    try {
      const response = await requirementIntakeApi.getActiveDraft(conversationId);
      if (response.data.data) {
        setDraft(response.data.data);
        setQuestions(response.data.data.questions ?? []);
      } else {
        setDraft(null);
        setQuestions([]);
      }
      setState('ready');
    } catch {
      setDraft(null);
      setQuestions([]);
      setState('ready');
    }
  }, [conversationId]);

  useEffect(() => {
    loadActiveDraft();
  }, [loadActiveDraft]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [questions, draft, state]);

  const handleCreateDraft = useCallback(async (message: string) => {
    if (!message.trim() || sending) return;

    setSending(true);
    try {
      const response = await requirementIntakeApi.createDraft({
        message,
        conversationId,
      });
      if (response.data.data) {
        setDraft(response.data.data);
        setQuestions(response.data.data.questions ?? []);
        setState('ready');
      }
    } catch (err) {
      console.error('Failed to create draft:', err);
    } finally {
      setSending(false);
    }
  }, [conversationId, sending]);

  const handleAnswerQuestion = useCallback(async (question: ClarificationQuestion, answer: string) => {
    if (!draft || !answer.trim()) return;

    setSending(true);
    try {
      const response = await requirementIntakeApi.answerClarification({
        draftId: draft.id,
        field: question.field,
        answer: answer.trim(),
      });
      if (response.data.data) {
        setDraft(response.data.data);
        setQuestions(response.data.data.questions ?? []);
      }
    } catch (err) {
      console.error('Failed to answer question:', err);
    } finally {
      setSending(false);
    }
  }, [draft]);

  const handleConfirmDraft = useCallback(async () => {
    if (!draft || state === 'confirming') return;

    setState('confirming');
    try {
      const response = await requirementIntakeApi.confirmDraft({ draftId: draft.id });
      if (response.data.data) {
        toast.success('Requirement confirmed! Procurement request created.');
        onRequestCreated?.(response.data.data.requestId);
        setDraft(null);
        setQuestions([]);
        setState('empty');
      }
    } catch (err) {
      console.error('Failed to confirm draft:', err);
      toast.error('Failed to confirm requirement');
    } finally {
      setState('ready');
    }
  }, [draft, onRequestCreated, state]);

  const handleSendMessage = useCallback(() => {
    if (!input.trim() || sending) return;

    const text = input.trim();
    setInput('');

    if (draft && questions.some(q => !q.userAnswer)) {
      const unanswered = questions.find(q => !q.userAnswer);
      if (unanswered) {
        handleAnswerQuestion(unanswered, text);
        return;
      }
    }

    handleCreateDraft(text);
  }, [input, sending, draft, questions, handleAnswerQuestion, handleCreateDraft]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage();
    }
  }, [handleSendMessage]);

  if (state === 'loading') {
    return (
      <div className={`card flex flex-col h-full ${className}`}>
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  const isConfirmable = draft?.state === 'DRAFT' || draft?.state === 'CONFIRMED';
  const unansweredCount = questions.filter(q => !q.userAnswer).length;

  return (
    <div className={`card flex flex-col h-full ${className}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-blue-600" />
          <h2 className="text-sm font-semibold text-stone-900">AI Requirement Intake</h2>
        </div>
        {draft && (
          <Badge variant={isConfirmable ? 'success' : 'warning'} className="text-xs">
            {draft.state}
          </Badge>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {state === 'empty' && (
          <div className="mx-auto max-w-2xl text-center py-8">
            <Bot className="h-12 w-12 text-stone-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-stone-900">What do you need to procure?</h3>
            <p className="mt-1 text-sm text-stone-600">
              Describe your need in natural language. I'll extract the details and guide you
              through any missing information.
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {[
                'I need 20 laptops for my engineering team',
                'Find a vendor for office cleaning services',
                'We need 500 units of packaging material',
                'Software development services for a CRM migration',
              ].map((starter) => (
                <button
                  key={starter}
                  onClick={() => handleCreateDraft(starter)}
                  disabled={sending}
                  className="card card-hover px-4 py-3 text-left text-sm text-stone-700"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        )}

        {draft && (
          <div className="space-y-4">
            <div className="card p-4 border-blue-200 bg-blue-50/50">
              <h4 className="font-medium text-stone-900">{draft.title ?? draft.item ?? 'Untitled Requirement'}</h4>
              <div className="mt-2 grid gap-1 text-sm text-stone-700">
                {draft.category && <p><span className="font-medium">Category:</span> {draft.category}</p>}
                {draft.item && <p><span className="font-medium">Item:</span> {draft.item}</p>}
                {draft.quantity && <p><span className="font-medium">Quantity:</span> {draft.quantity} {draft.unit ?? ''}</p>}
                {draft.location && <p><span className="font-medium">Location:</span> {draft.location}</p>}
                {draft.requiredDate && <p><span className="font-medium">Required by:</span> {new Date(draft.requiredDate).toLocaleDateString()}</p>}
                {draft.estimatedBudget && <p><span className="font-medium">Budget:</span> {draft.currency} {draft.estimatedBudget}</p>}
              </div>
            </div>

            {questions.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-medium text-stone-900 flex items-center gap-2">
                  Clarification Questions
                  <span className="badge-blue text-xs">{questions.length} total · {unansweredCount} unanswered</span>
                </h4>
                {questions.map((question) => (
                  <div key={question.id} className="card p-4">
                    <div className="flex items-start gap-2">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full border border-stone-300 flex items-center justify-center text-xs font-medium text-stone-600">
                        {question.order}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-stone-800">{question.question}</p>
                        {question.suggestion && (
                          <p className="text-xs text-stone-500 mt-0.5">Suggestion: {question.suggestion}</p>
                        )}
                        {question.userAnswer ? (
                          <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Answered: {question.userAnswer}
                          </p>
                        ) : (
                          <div className="mt-2">
                            <input
                              type="text"
                              placeholder={`Answer for ${question.field}...`}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleAnswerQuestion(question, (e.currentTarget as HTMLInputElement).value);
                                  (e.currentTarget as HTMLInputElement).value = '';
                                }
                              }}
                              className="w-full px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {isConfirmable && unansweredCount === 0 && (
              <div className="card p-4 border-emerald-200 bg-emerald-50/50">
                <div className="flex items-center gap-2 text-emerald-800">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">All critical fields are complete. Ready to confirm.</span>
                </div>
                <Button
                  className="mt-3"
                  onClick={handleConfirmDraft}
                  loading={state === 'confirming'}
                  disabled={state === 'confirming'}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Confirm & Create Procurement Request
                </Button>
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="border-t border-stone-200 px-4 py-3">
        {draft && questions.length > 0 && unansweredCount === 0 && isConfirmable && (
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-emerald-700 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Ready to confirm
            </span>
          </div>
        )}

        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={draft
              ? questions.some(q => !q.userAnswer)
                ? 'Answer the question above…'
                : isConfirmable
                ? 'Type "confirm" to create the request, or ask a follow-up…'
                : 'Continue describing your requirement…'
              : 'Describe what you need to procure…'}
            className="flex-1 resize-none border border-stone-200 rounded-lg px-3 py-2 text-sm outline-none placeholder:text-stone-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            disabled={sending || state === 'confirming'}
          />
          <Button
            size="sm"
            onClick={handleSendMessage}
            loading={sending}
            disabled={!input.trim() || sending || state === 'confirming'}
          >
            <Send className="h-4 w-4" />
            Send
          </Button>
        </div>

        <p className="mt-2 text-[11px] text-stone-400 text-center">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
};
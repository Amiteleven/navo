import React, { useState } from 'react';
import { Sparkles, Send, Loader2, Database, AlertTriangle } from 'lucide-react';
import { purchaseOrderApi, AssistantAnswer } from '../services/api';

interface Exchange {
  id: string;
  question: string;
  answer: AssistantAnswer | null;
  failed: boolean;
}

/**
 * The assistant is deterministic: it restates stored records and cites the
 * models it read. The UI states that plainly rather than implying a live model,
 * so nobody treats the answer as anything other than a query over this order.
 */
export const AssistantPanel: React.FC<{ poId: string }> = ({ poId }) => {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);

  const suggestions = exchanges.length
    ? (exchanges[exchanges.length - 1].answer?.suggestedQuestions ?? [])
    : ['What is the current status of this order?', 'How much has been paid so far?'];

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setExchanges((prev) => [...prev, { id, question: trimmed, answer: null, failed: false }]);
    setQuestion('');
    setBusy(true);

    try {
      const response = await purchaseOrderApi.ask(trimmed, poId);
      const answer = (response.data.data ?? null) as AssistantAnswer | null;
      setExchanges((prev) =>
        prev.map((e) => (e.id === id ? { ...e, answer, failed: !answer } : e))
      );
    } catch {
      setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, failed: true } : e)));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask(question);
  };

  return (
    <section className="space-y-4">
      <div className="card border-blue-200 bg-blue-50/40 p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
          <Sparkles className="h-4 w-4 text-blue-600" aria-hidden="true" />
          Ask about this order
        </h2>
        <p className="mt-1 text-xs text-stone-600">
          Answers are generated from this purchase order&apos;s own records. Every answer lists the
          records it was derived from, so you can check it against the tabs above.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <label htmlFor="assistant-question" className="sr-only">
          Question about this purchase order
        </label>
        <input
          id="assistant-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Why is this order still awaiting confirmation?"
          maxLength={1000}
          className="block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button type="submit" disabled={busy || !question.trim()} className="btn btn-primary shrink-0">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
          Ask
        </button>
      </form>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              disabled={busy}
              className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-600 transition-colors hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {exchanges.length === 0 && (
        <p className="text-sm text-stone-500">No questions asked yet.</p>
      )}

      <ol className="space-y-4">
        {exchanges.map((entry) => (
          <li key={entry.id} className="space-y-2">
            <p className="flex justify-end">
              <span className="rounded-lg rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white">
                {entry.question}
              </span>
            </p>

            {entry.failed ? (
              <p className="flex items-start gap-1.5 rounded-lg rounded-bl-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                The assistant could not be reached. Try again.
              </p>
            ) : !entry.answer ? (
              <p className="flex items-center gap-1.5 rounded-lg rounded-bl-sm border border-stone-200 p-3 text-sm text-stone-500">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Reading this order&apos;s records…
              </p>
            ) : (
              <div className="rounded-lg rounded-bl-sm border border-stone-200 p-3">
                <p className="text-sm text-stone-800">{entry.answer.answer}</p>

                {entry.answer.notAnswerable && (
                  <p className="mt-2 text-xs text-amber-700">
                    This order has no stored answer to that question.
                  </p>
                )}

                <div className="mt-2 border-t border-stone-100 pt-2">
                  <p className="flex items-center gap-1 text-xs font-medium text-stone-500">
                    <Database className="h-3 w-3" aria-hidden="true" />
                    Answered from application data
                  </p>
                  {entry.answer.evidence.length > 0 && (
                    <p className="mt-1 text-xs text-stone-400">
                      Records read: {entry.answer.evidence.join(', ')}
                    </p>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};

export default AssistantPanel;

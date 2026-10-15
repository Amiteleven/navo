import { config } from '../../config/index.js';

/**
 * Email templates.
 *
 * The rule these templates exist to enforce: **an email preview must never
 * contain confidential commercial data.** No prices, no quantities, no
 * attachment names, no counterparty contact details, no buyer identity beyond
 * what the recipient already knows.
 *
 * Every template therefore receives a short `preview` string that the caller
 * must construct from non-confidential facts, and links back to NAVO where the
 * authenticated user sees the detail. This is what keeps a shared or forwarded
 * notification from leaking a deal.
 */

export type NotificationEvent =
  | 'VENDOR_INVITATION'
  | 'INVITATION_ACCEPTED'
  | 'NEW_OPPORTUNITY'
  | 'CONNECTION_REQUEST'
  | 'QUOTE_RESPONSE'
  | 'DEAL_STATUS_CHANGE'
  | 'AVAILABILITY_CHANGE'
  | 'VENDOR_FEEDBACK'
  | 'REQUIREMENT_PUBLISHED'
  | 'MARKETPLACE_INTEREST'
  | 'NEGOTIATION_MESSAGE'
  | 'COUNTEROFFER'
  | 'OFFER_ACCEPTED'
  | 'DEAL_CLOSED'
  | 'APPROVAL_ASSIGNED'
  | 'APPROVAL_APPROVED'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_CHANGES_REQUESTED'
  | 'PURCHASE_CONFIRMED';

export interface TemplateInput {
  recipientName: string;
  preview: string;
  linkPath: string;
  dedupeKey: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  dedupeKey: string;
}

/** Human-readable framing per event. Deliberately vague about terms. */
const FRAMING: Record<NotificationEvent, { subject: (p: string) => string; intro: string }> = {
  VENDOR_INVITATION: {
    subject: () => 'You have been invited to NAVO',
    intro: 'You have been invited to join as a supplier.',
  },
  INVITATION_ACCEPTED: { subject: () => 'An invitation was accepted', intro: 'An invitation has been accepted.' },
  NEW_OPPORTUNITY: { subject: (p) => `New opportunity: ${p}`, intro: 'A requirement matches your categories.' },
  CONNECTION_REQUEST: { subject: () => 'New connection request', intro: 'A buyer would like to connect with you.' },
  QUOTE_RESPONSE: { subject: (p) => `Quotation received: ${p}`, intro: 'A buyer submitted a quotation.' },
  DEAL_STATUS_CHANGE: { subject: (p) => `Deal update: ${p}`, intro: 'A deal has changed status.' },
  AVAILABILITY_CHANGE: { subject: () => 'Availability updated', intro: 'Availability has changed.' },
  VENDOR_FEEDBACK: { subject: () => 'New feedback', intro: 'A buyer left feedback.' },
  REQUIREMENT_PUBLISHED: {
    subject: (p) => `Requirement published: ${p}`,
    intro: 'One of your requirements was published.',
  },
  MARKETPLACE_INTEREST: {
    subject: (p) => `A supplier is interested: ${p}`,
    intro: 'An eligible supplier expressed interest in your requirement.',
  },
  NEGOTIATION_MESSAGE: {
    subject: (p) => `New message: ${p}`,
    intro: 'You have unread messages in a negotiation room.',
  },
  COUNTEROFFER: { subject: () => 'New counteroffer', intro: 'A counteroffer is waiting for you.' },
  OFFER_ACCEPTED: { subject: () => 'Offer accepted', intro: 'An offer has been accepted.' },
  DEAL_CLOSED: { subject: () => 'Deal closed', intro: 'A deal has been closed.' },

  // Approval events. The framing is deliberately institutional rather than
  // commercial: an approval request is a request for authorization, and the
  // previews below carry no figure, vendor or counterparty detail.
  APPROVAL_ASSIGNED: {
    subject: (p) => `Purchase approval requested: ${p}`,
    intro: 'A purchase has been submitted for your approval.',
  },
  APPROVAL_APPROVED: {
    subject: (p) => `Purchase approved: ${p}`,
    intro: 'Your purchase has been approved and can be confirmed.',
  },
  APPROVAL_REJECTED: {
    subject: (p) => `Purchase rejected: ${p}`,
    intro: 'Your purchase has been rejected.',
  },
  APPROVAL_CHANGES_REQUESTED: {
    subject: (p) => `Changes requested: ${p}`,
    intro: 'An approver has asked for changes to your purchase.',
  },
  PURCHASE_CONFIRMED: {
    subject: (p) => `Purchase confirmed: ${p}`,
    intro: 'An approved purchase has been confirmed.',
  },
};

/**
 * Strip anything commercially sensitive from a preview before it leaves NAVO.
 *
 * Callers are expected to pass non-confidential summaries, but a single caller
 * building a sloppy summary must not be able to put a counterparty's price on
 * the wire. This runs at the boundary - the last point before an email is
 * persisted and sent - so it protects against every current and future caller,
 * not just the ones that remembered the rule.
 *
 * It is deliberately conservative and over-redacts rather than trying to decide
 * whether a number is actually sensitive: a false positive costs a vaguer email,
 * a false negative leaks a deal.
 */
export function sanitizePreview(preview: string): string {
  return preview
    // Email addresses.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted]')
    // Phone-like digit runs with separators.
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted]')
    // Quantities with a unit, e.g. "200 units", "1.5 tons".
    .replace(
      /\b\d[\d.,]*\s*(?:units?|pcs|pieces|items?|kg|kgs|tons?|tonnes?|litres?|liters?|l|ml|m|m2|m3|boxes|pallets?|sets?)\b/gi,
      '[redacted]'
    )
    // Monetary amounts, e.g. "48,000", "$48000.50", "EUR 1 200".
    .replace(
      /(?:[A-Z]{3}\s*)?[$€£₹]?\b\d{1,3}(?:[,. ]\d{3})+(?:[.,]\d{1,2})?\b|\b[$€£₹]\s*\d+(?:[.,]\d{1,2})?\b/g,
      '[redacted]'
    )
    // Percentages, which frequently encode a negotiated discount or margin.
    .replace(/\b\d+(?:[.,]\d+)?\s*%/g, '[redacted]')
    // Attachment filenames.
    .replace(/\b[\w .-]+\.(?:pdf|docx?|xlsx?|csv|pptx?|zip|jpe?g|png|gif|msg|eml)\b/gi, '[redacted]');
}

/**
 * Collapse runs of placeholder text so a heavily redacted preview still reads
 * as a sentence rather than as "[redacted] [redacted] [redacted]".
 */
function tidy(redacted: string): string {
  const deduped = redacted.replace(/(?:\[redacted\][\s,;-]*){2,}/g, '[redacted] ');
  return deduped.replace(/\s{2,}/g, ' ').replace(/[\s,;]+$/, '').trim();
}

function build(event: NotificationEvent, input: TemplateInput): RenderedEmail {
  const framing = FRAMING[event];
  const link = `${config.appUrl}${input.linkPath}`;

  // Sanitize before truncating: truncating first could split a redaction match
  // and leave part of a figure behind.
  const preview = tidy(sanitizePreview(input.preview)).slice(0, 120);

  const text = [
    `Hello ${input.recipientName},`,
    '',
    framing.intro,
    preview ? `  ${preview}` : '',
    '',
    'Sign in to NAVO to view the details:',
    link,
    '',
    'For your protection, this email does not include contract terms, prices or',
    'documents. Sign in to review them.',
    '',
    'You can change what you are notified about in NAVO notification settings.',
    '',
    '— NAVO',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#fafaf9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#292524;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:28px;">
    <p style="margin:0 0 16px;font-size:14px;color:#78716c;">Hello ${escapeHtml(input.recipientName)},</p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(framing.intro)}</p>
    ${
      preview
        ? `<p style="margin:0 0 20px;padding:12px 14px;background:#f5f5f4;border-left:3px solid #2563eb;border-radius:6px;font-size:14px;line-height:1.6;">${escapeHtml(preview)}</p>`
        : ''
    }
    <p style="margin:0 0 20px;">
      <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;">Open NAVO</a>
    </p>
    <p style="margin:0 0 8px;font-size:12px;color:#78716c;line-height:1.6;">
      This email does not include contract terms, prices or documents. Sign in to review them.
    </p>
    <p style="margin:0;font-size:12px;color:#a8a29e;line-height:1.6;">
      Manage notifications in your NAVO settings.
    </p>
  </div>
</body></html>`;

  return {
    subject: framing.subject(preview),
    text,
    html,
    dedupeKey: input.dedupeKey,
  };
}

/** Escape interpolated values so a preview can never inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmail(event: NotificationEvent, input: TemplateInput): RenderedEmail {
  return build(event, input);
}
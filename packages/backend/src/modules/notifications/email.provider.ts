import { config } from '../../config/index.js';

/**
 * Email provider abstraction.
 *
 * NAVO does not hard-code a vendor. `EmailProvider` is the seam, and the
 * concrete implementation is chosen entirely by environment configuration, so
 * a deployment can move between SMTP, an HTTP API, or a no-op recorder without
 * a code change.
 *
 * `LOG` mode is deliberate and is the default when nothing is configured: in
 * development the notification pipeline must still run end to end - dedupe,
 * preference checks, retry accounting - without requiring a real mailbox. It
 * reports success so the outbox drains rather than accumulating forever.
 */

export interface SendInput {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}

export interface SendOutcome {
  sent: boolean;
  /** True when the failure is worth another attempt later. */
  retryable: boolean;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendInput): Promise<SendOutcome>;
}

/** Development default: records what would be sent. */
class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  private readonly sink: SendInput[] = [];

  async send(input: SendInput): Promise<SendOutcome> {
    this.sink.push(input);
    if (this.sink.length > 200) this.sink.shift();
    return { sent: true, retryable: false };
  }

  /** Test/diagnostic accessor. */
  get outbox(): readonly SendInput[] {
    return this.sink;
  }
}

/**
 * SMTP over nodemailer when installed.
 *
 * Loaded lazily and through a dynamic import so nodemailer stays an optional
 * dependency: a deployment that uses an HTTP provider does not need it, and a
 * deployment with no mail configured never touches it.
 */
class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';

  private transporter: {
    sendMail: (message: Record<string, unknown>) => Promise<unknown>;
  } | null = null;

  private readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  private async getTransporter(): Promise<{
    sendMail: (message: Record<string, unknown>) => Promise<unknown>;
  }> {
    if (this.transporter) return this.transporter;

    type Nodemailer = {
      createTransport: (o: Record<string, unknown>) => {
        sendMail: (message: Record<string, unknown>) => Promise<unknown>;
      };
    };
    const nodemailer = (await import('nodemailer')) as unknown as Nodemailer;
    this.transporter = nodemailer.createTransport(this.options);
    return this.transporter;
  }

  async send(input: SendInput): Promise<SendOutcome> {
    try {
      const transporter = await this.getTransporter();
      await transporter.sendMail({
        from: config.email.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html ?? undefined,
      });
      return { sent: true, retryable: false };
    } catch (err) {
      // 4xx is transient (throttling, greylisting); 5xx is not. Retry the
      // former so a provider blip does not cost the user a real notification.
      const message = (err as Error).message ?? 'unknown';
      const status = (err as { responseCode?: number }).responseCode;
      return {
        sent: false,
        retryable: status === undefined || status < 500,
        error: message,
      };
    }
  }
}

/**
 * Generic HTTP provider (SendGrid, Postmark, Resend - anything with a JSON
 * POST endpoint). Avoids adding a vendor-specific dependency.
 */
class HttpEmailProvider implements EmailProvider {
  readonly name = 'http';

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async send(input: SendInput): Promise<SendOutcome> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html ?? undefined,
        }),
      });

      if (response.ok) return { sent: true, retryable: false };
      if (response.status >= 500 || response.status === 429) {
        return { sent: false, retryable: true, error: `HTTP ${response.status}` };
      }
      return { sent: false, retryable: false, error: `HTTP ${response.status}` };
    } catch (err) {
      // A network-level failure is always worth retrying.
      return { sent: false, retryable: true, error: (err as Error).message };
    }
  }
}

let cached: EmailProvider | null = null;

/**
 * Build the configured provider.
 *
 * Precedence: explicit HTTP endpoint, then SMTP, then the log recorder. This
 * is resolved once and cached, so a misconfigured deployment fails the same way
 * on every call rather than intermittently.
 */
export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  const { email } = config;

  if (email.provider === 'http' && email.endpoint && email.apiKey) {
    cached = new HttpEmailProvider(email.endpoint, email.apiKey, email.from);
  } else if (email.provider === 'smtp' && email.smtpHost) {
    cached = new SmtpEmailProvider({
      host: email.smtpHost,
      port: email.smtpPort,
      secure: email.smtpSecure,
      auth: email.smtpUser ? { user: email.smtpUser, pass: email.smtpPassword } : undefined,
    });
  } else {
    cached = new LogEmailProvider();
  }

  return cached;
}

/** Test seam: inject a provider. */
export function setEmailProvider(provider: EmailProvider | null): void {
  cached = provider;
}
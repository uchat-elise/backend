const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class EmailService {
  constructor({ apiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY, fromEmail = process.env.FROM_EMAIL, appUrl = process.env.APP_URL } = {}) {
    this.apiKey = apiKey;
    this.fromEmail = fromEmail || 'onboarding@resend.dev';
    this.appUrl = (appUrl || 'http://localhost:5173').replace(/\/$/, '');
    this.isConfigured = Boolean(this.apiKey && this.fromEmail);

    if (process.env.NODE_ENV === 'production' && !this.isConfigured) {
      throw new Error('EMAIL_API_KEY and FROM_EMAIL are required for email verification');
    }
    if (process.env.NODE_ENV === 'production' && !this.appUrl.startsWith('https://')) {
      throw new Error('APP_URL must use HTTPS in production');
    }
  }

  async sendVerificationEmail({ email, displayName, token }) {
    const verificationLink = `${this.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    if (!this.isConfigured) {
      console.warn('Email service not configured; returning local verification link for development:', verificationLink);
      return { verificationLink };
    }

    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromEmail,
        to: [email],
        subject: 'Verify your Uchat email',
        text: `Hi ${displayName || 'there'},\n\nVerify your Uchat account by opening this link:\n${verificationLink}\n\nThis link expires in 15 minutes and can only be used once.`,
        html: `<p>Hi ${displayName || 'there'},</p><p>Verify your Uchat account by clicking the link below:</p><p><a href="${verificationLink}">Verify your email</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const message = `Email provider rejected the verification email (${response.status}): ${detail}`;
      console.error(message);
      throw new Error(message);
    }

    return { verificationLink };
  }
}

/**
 * Photographer-only email. v1 sends NO client email by design: clients gave a
 * name chip, never an address; the in-gallery banner carries expiry urgency.
 *
 * Two transports, tried in order:
 *   1. Cloudflare-native (preferred): the Email Routing `send_email` binding —
 *      free, no vendor, no API key. Constraints fit this product exactly: the
 *      From must live on the zone (selects@<zone>) and the To must be a
 *      VERIFIED Email Routing destination — and the only recipient is the
 *      photographer's own verified address.
 *   2. Resend (fallback): kept for the day native sending isn't enough
 *      (client email would need real deliverability work anyway).
 *
 * Returns true ONLY when a transport accepted the message — callers must not
 * commit "already notified" state on false (review finding: a no-op/failure
 * must never swallow a notification forever).
 */

export async function emailPhotographer(env: Env, subject: string, html: string): Promise<boolean> {
  const to = env.PHOTOGRAPHER_EMAIL;
  if (!to) {
    console.log(`[email noop — no PHOTOGRAPHER_EMAIL] ${subject}`);
    return false;
  }

  if (env.NOTIFY) {
    try {
      const { EmailMessage } = await import('cloudflare:email');
      const zone = new URL(env.PUBLIC_ORIGIN ?? 'https://ryuxik.io').hostname;
      const from = `selects@${zone}`;
      await env.NOTIFY.send(new EmailMessage(from, to, buildMime(from, to, zone, subject, html)));
      return true;
    } catch (error) {
      console.log(`[email native failed] ${subject}: ${String(error)}`);
      // fall through to Resend if configured
    }
  }

  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM ?? 'Selects <selects@mail.ryuxik.io>',
          to: [to],
          subject,
          html,
        }),
      });
      if (res.ok) return true;
      console.log(`[email resend failed ${res.status}] ${subject}: ${await res.text()}`);
    } catch (error) {
      console.log(`[email resend threw] ${subject}: ${String(error)}`);
    }
  } else if (!env.NOTIFY) {
    console.log(`[email noop — no transport configured] ${subject}`);
  }
  return false;
}

/* Minimal RFC 5322 message: HTML body base64-encoded, subject RFC 2047-encoded
 * (our subjects carry em dashes). Hand-rolled because the obvious npm MIME
 * builders drag Node builtins into the Worker bundle for no gain. */
function buildMime(from: string, to: string, zone: string, subject: string, html: string): string {
  const utf8ToB64 = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  };
  // RFC 2047: each encoded-word tops out at 75 chars INCLUDING the
  // =?utf-8?B?…?= overhead (12 chars) — so at most 45 UTF-8 bytes of subject
  // per word, split on code-point boundaries and folded with CRLF+space.
  // One over-long word is exactly how "do-not-post list changed" subjects
  // arrived garbled.
  const encodeSubject = (text: string): string => {
    const words: string[] = [];
    let chunk = '';
    let bytes = 0;
    for (const ch of text) {
      const b = new TextEncoder().encode(ch).length;
      if (bytes + b > 45) { words.push(chunk); chunk = ''; bytes = 0; }
      chunk += ch;
      bytes += b;
    }
    if (chunk) words.push(chunk);
    return words.map((w) => `=?utf-8?B?${utf8ToB64(w)}?=`).join('\r\n ');
  };
  const shell = `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;max-width:34em">${html}</div>`;
  const body = utf8ToB64(shell).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: Selects <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${zone}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

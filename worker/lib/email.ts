/**
 * Photographer-only email via Resend (docs/LAUNCH.md already names Resend for
 * the inquiry form — one vendor). v1 sends NO client email by design: clients
 * gave a name chip, never an address; the in-gallery banner carries expiry
 * urgency (review § R8). Without RESEND_API_KEY every send is a logged no-op,
 * so local dev and a fresh deploy degrade quietly instead of failing loudly.
 */

/** Returns true only when Resend accepted the message — callers must NOT
 * commit "already notified" state on false, or a no-op/failure silently
 * swallows the notification forever (review finding). */
export async function emailPhotographer(env: Env, subject: string, html: string): Promise<boolean> {
  const to = env.PHOTOGRAPHER_EMAIL;
  if (!env.RESEND_API_KEY || !to) {
    console.log(`[email noop] ${subject}`);
    return false;
  }
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
  if (!res.ok) {
    console.log(`[email failed ${res.status}] ${subject}: ${await res.text()}`);
    return false;
  }
  return true;
}

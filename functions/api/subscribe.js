// File: /functions/api/subscribe.js
//
// One endpoint for two kinds of forms, both feeding the existing ISC Mailchimp audience (MAILCHIMP_LIST_ID):
//   - Guide downloads (resource pages): send resource_tag = "Resource Download - ...". The guide PDF is
//     delivered whenever the request is valid. New contacts are subscribed and tagged; existing contacts
//     are tagged and their subscription status is left as it is (same as before).
//   - Newsletter signups (/insights/): send form_type = "newsletter". Contacts are added or updated by
//     Mailchimp's rules and the response says what actually happened:
//       new contact          -> subscribed + tagged                       status "subscribed"
//       already subscribed   -> tagged                                    status "already_subscribed"
//       unsubscribed         -> set to "pending" (Mailchimp sends its re-opt-in confirmation email) + tagged
//                                                                         status "pending"
//       pending              -> tagged, still awaiting confirmation       status "pending"
//       transactional        -> subscribed (they opted in on the form) + tagged   status "subscribed"
//       cleaned / blocked    -> not subscribed                            success false, status "cannot_subscribe"

// Only these Mailchimp tags may be applied. Anything else sent by a browser is rejected, so a form
// submission can never create a new tag in the audience.
const ALLOWED_TAGS = new Set([
  'Newsletter Signup - Insights',
  'Resource Download - DU LPA Guide',
  'Resource Download - Frozen Bureau Pulls Guide',
  'Resource Download - How to Order a Supplement Guide',
  'Resource Download - PowerProfile Plus Guide',
  'Resource Download - Rapid Rescore Guide',
  'Resource Download - SmartSelect Guide',
  'Resource Download - Supplement Checklist',
  'Resource Download - VantageScore Guide'
]);
const NEWSLETTER_TAG = 'Newsletter Signup - Insights';

export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const email = String(formData.get('EMAIL') || '').trim();
    const firstName = String(formData.get('FNAME') || '').trim();
    const tag = String(formData.get('resource_tag') || '').trim();
    const token = formData.get('cf-turnstile-response');
    const isNewsletter = formData.get('form_type') === 'newsletter';

    // 1. Cloudflare Turnstile
    if (!token) return json({ success: false, error: 'Missing Security Verification Token' }, 400);
    const turnstileVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(context.env.TURNSTILE_SECRET_KEY || '')}&response=${encodeURIComponent(token)}`
    });
    const turnstileResult = await turnstileVerify.json();
    if (!turnstileResult.success) return json({ success: false, error: 'Security Verification Failed' }, 400);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ success: false, error: 'Invalid email address' }, 400);

    // Tag whitelist: unknown tags are rejected; newsletter signups may only carry the newsletter tag,
    // and guide downloads may not carry it.
    if (tag && !ALLOWED_TAGS.has(tag)) {
      console.warn('SUBSCRIBE rejected: tag not on the allowed list:', JSON.stringify(tag.slice(0, 80)));
      return json({ success: false, error: 'Invalid form submission' }, 400);
    }
    if ((isNewsletter && tag && tag !== NEWSLETTER_TAG) || (!isNewsletter && tag === NEWSLETTER_TAG)) {
      console.warn('SUBSCRIBE rejected: tag does not match form type:', tag);
      return json({ success: false, error: 'Invalid form submission' }, 400);
    }

    // 2. Mailchimp settings (Cloudflare environment variables)
    const API_KEY = context.env.MAILCHIMP_API_KEY;
    const LIST_ID = context.env.MAILCHIMP_LIST_ID;
    const DATACENTER = context.env.MAILCHIMP_DATACENTER; // e.g. 'us20'
    if (!API_KEY || !LIST_ID || !DATACENTER) return json({ success: false, error: 'Mailchimp is not configured yet.' }, 500);

    const base = `https://${DATACENTER}.api.mailchimp.com/3.0/lists/${LIST_ID}/members/${md5(email.toLowerCase())}`;
    const mc = async (url, method, body) => {
      const res = await fetch(url, {
        method,
        headers: { 'Authorization': `Basic ${btoa(`anystring:${API_KEY}`)}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      let data = {};
      if (res.status !== 204) { try { data = await res.json(); } catch (e) { data = {}; } }
      return { ok: res.ok, status: res.status, data };
    };
    // Tagging only ever POSTs to the member's /tags endpoint; it never changes subscription status.
    // One retry; if both attempts fail, log it for diagnosis and carry on (the signup or download still completes).
    const maskedEmail = email.replace(/^(.).*(@.*)$/, '$1***$2');
    const addTag = async () => {
      if (!tag) return true;
      let last = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await mc(`${base}/tags`, 'POST', { tags: [{ name: tag, status: 'active' }] });
          if (r.ok) return true;
          last = `HTTP ${r.status} ${r.data.title || ''} ${r.data.detail || ''}`.trim();
        } catch (e) {
          last = `request error: ${e.message}`;
        }
      }
      console.error(`MAILCHIMP TAG FAILED after 2 attempts | tag="${tag}" | contact=${maskedEmail} | ${last}`);
      return false;
    };

    // 3. Look the contact up
    const existing = await mc(base, 'GET');
    const memberStatus = existing.ok ? existing.data.status : null; // null = not in the audience

    // 3a. New contact (both form types): subscribe, then tag
    if (!memberStatus) {
      if (existing.status !== 404) throw new Error(existing.data.detail || 'Mailchimp lookup failed');
      const created = await mc(base, 'PUT', {
        email_address: email,
        status_if_new: 'subscribed',
        merge_fields: { FNAME: firstName }
      });
      if (!created.ok) {
        // e.g. a contact Mailchimp has permanently removed ("forgotten") or flagged for compliance
        console.log('MAILCHIMP add failed:', created.status, created.data.title);
        if (isNewsletter) return json({ success: false, status: 'cannot_subscribe' }, 200);
        throw new Error(created.data.detail || 'Mailchimp API Error');
      }
      await addTag();
      return json({ success: true, status: 'subscribed' }, 200);
    }

    // 3b. Existing contact from a guide download: tag only, status unchanged (previous behavior), PDF delivered
    if (!isNewsletter) {
      await addTag();
      return json({ success: true, status: memberStatus }, 200);
    }

    // 3c. Existing contact from a newsletter signup
    const fillName = firstName && !(existing.data.merge_fields && existing.data.merge_fields.FNAME) ? { merge_fields: { FNAME: firstName } } : {};
    if (memberStatus === 'subscribed') {
      if (fillName.merge_fields) await mc(base, 'PATCH', fillName);
      await addTag();
      return json({ success: true, status: 'already_subscribed' }, 200);
    }
    if (memberStatus === 'pending') {
      await addTag();
      return json({ success: true, status: 'pending' }, 200);
    }
    if (memberStatus === 'transactional' || memberStatus === 'archived') {
      const up = await mc(base, 'PUT', { email_address: email, status: 'subscribed', ...fillName });
      if (up.ok) { await addTag(); return json({ success: true, status: 'subscribed' }, 200); }
      // Mailchimp refuses a direct resubscribe for some contacts; fall through to re-opt-in
    }
    if (memberStatus === 'unsubscribed' || memberStatus === 'transactional' || memberStatus === 'archived') {
      // Mailchimp does not allow resubscribing an unsubscribed contact directly. "pending" makes
      // Mailchimp send its own confirmation email; the contact is subscribed only after they confirm.
      const re = await mc(base, 'PUT', { email_address: email, status: 'pending', ...fillName });
      if (re.ok) { await addTag(); return json({ success: true, status: 'pending' }, 200); }
      console.log('MAILCHIMP re-opt-in failed:', re.status, re.data.title);
      return json({ success: false, status: 'cannot_subscribe' }, 200);
    }
    // cleaned (bounced) or any other state Mailchimp will not subscribe
    return json({ success: false, status: 'cannot_subscribe' }, 200);

  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Mailchimp identifies a contact by the MD5 hash of the lowercase email address.
// Small self-contained MD5 (works the same in Cloudflare Workers and local tests).
function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const len = bytes.length, nBlocks = ((len + 8) >> 6) + 1, words = new Uint32Array(nBlocks * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[nBlocks * 16 - 2] = (len * 8) >>> 0;
  words[nBlocks * 16 - 1] = Math.floor(len / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < nBlocks; blk++) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + words[blk * 16 + g]) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return [a0, b0, c0, d0].map(v => [0, 8, 16, 24].map(sh => ((v >>> sh) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

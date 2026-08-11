// File: /functions/api/subscribe.js

export async function onRequestPost(context) {
  try {
    // 1. Extract data from the frontend request
    const formData = await context.request.formData();
    const email = formData.get('EMAIL');
    const firstName = formData.get('FNAME');
    const tag = formData.get('resource_tag');
    const token = formData.get('cf-turnstile-response');

    // 2. Protect with Cloudflare Turnstile CAPTCHA
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'Missing Security Verification Token' }), { status: 400 });
    }

    const turnstileVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${context.env.TURNSTILE_SECRET_KEY}&response=${token}`
    });

    const turnstileResult = await turnstileVerify.json();
    if (!turnstileResult.success) {
      return new Response(JSON.stringify({ success: false, error: 'Security Verification Failed' }), { status: 400 });
    }

    // 3. Load Environment Variables (Set in Cloudflare Dashboard later)
    const API_KEY = context.env.MAILCHIMP_API_KEY;
    const LIST_ID = context.env.MAILCHIMP_LIST_ID;
    const DATACENTER = context.env.MAILCHIMP_DATACENTER; // Usually something like 'us20'

    // 4. Validate Environment Variables
    if (!API_KEY || !LIST_ID || !DATACENTER) {
      return new Response(JSON.stringify({ success: false, error: "Mailchimp is not configured yet." }), { status: 500 });
    }

    // 4. Construct the Mailchimp API Payload
    const payload = {
      email_address: email,
      status: 'subscribed', // 'subscribed' auto-opts them in. Use 'pending' for double opt-in.
      merge_fields: {
        FNAME: firstName || ''
      },
      tags: [tag] // Applies Brian's specific resource tag automatically
    };

    // 5. Send to Mailchimp
    const response = await fetch(`https://${DATACENTER}.api.mailchimp.com/3.0/lists/${LIST_ID}/members`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`anystring:${API_KEY}`)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('MAILCHIMP STATUS:', response.status);
    console.log('MAILCHIMP RESPONSE:', JSON.stringify(data));
    console.log('LIST_ID USED:', LIST_ID);
    console.log('DATACENTER USED:', DATACENTER);
    // 6. Handle Mailchimp Responses
    // Mailchimp returns 400 if the user is already subscribed, which is fine, we still want to give them the PDF.
    if (response.ok || data.title === "Member Exists") {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } else {
      throw new Error(data.detail || "Mailchimp API Error");
    }

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}
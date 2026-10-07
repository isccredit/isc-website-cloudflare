/* ISC website forms: on-page confirmation messages.
   - Contact, homepage and lender forms (action="/api/submit"): sent with fetch. The success message appears
     only when the server confirms success (it answers a successful send with a redirect to ?success=true;
     every failure returns an error status). Without JavaScript the form still posts normally, and the page
     it returns to shows the same success message.
   - Guide download forms: window.iscGuideStatus() is called by each page's existing handler after the
     server confirms the signup, and on failure in place of the old alert().
   No API keys, endpoints or field names change. */
(function () {
  var css = '.form-status{margin-top:1rem;padding:1rem 1.1rem;border-radius:10px;font-family:"DM Sans",system-ui,sans-serif;font-size:.92rem;line-height:1.55;text-align:left}' +
    '.form-status:focus{outline:2px solid #0a1628;outline-offset:3px}' +
    '.form-status--ok{background:#ecfdf3;border:1px solid #86efac;color:#14532d}' +
    '.form-status--err{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b}' +
    '.form-status b{display:block;font-size:1rem;margin-bottom:.2rem}' +
    '.form-status a{color:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function statusBox(form) {
    var id = (form.id || 'form') + '-status';
    var box = document.getElementById(id);
    if (!box) {
      box = document.createElement('div');
      box.id = id; box.tabIndex = -1; box.hidden = true;
      form.parentNode.insertBefore(box, form.nextSibling);
    }
    return box;
  }
  function show(form, kind, html) {
    var box = statusBox(form);
    box.className = 'form-status form-status--' + kind;
    box.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
    box.innerHTML = html;
    box.hidden = false;
    try { box.focus({ preventScroll: true }); } catch (e) {}
    var r = box.getBoundingClientRect();
    if (r.top < 100 || r.bottom > window.innerHeight) {
      // place the message in the middle of the screen, clear of the sticky header
      var y = window.pageYOffset + r.top - Math.max(100, (window.innerHeight - r.height) / 2);
      window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
    }
  }
  function resetCheck(form) {
    var w = form.querySelector('.cf-turnstile');
    if (window.turnstile && w) { try { window.turnstile.reset(w); } catch (e) {} }
  }
  function ga(name, form) { if (typeof window.gtag === 'function') window.gtag('event', name, { form_id: form.id || 'form' }); }

  var PHONE = '<a href="tel:+18002902801">800-290-2801</a>';
  var OK = {
    'lender-solutions-form': '<b>Thank you. Your request was sent.</b>The ISC team will review your lender program details and follow up with you directly. Questions in the meantime? Call ' + PHONE + ', Monday to Friday, 9 AM to 5 PM Pacific.',
    _default: '<b>Thank you. Your message was sent.</b>A member of the ISC team will follow up with you directly. Need help right away? Call ' + PHONE + ', Monday to Friday, 9 AM to 5 PM Pacific.'
  };
  var ERR = '<b>Your message was not sent.</b>Please try again. If it keeps happening, call ' + PHONE + ' or email <a href="mailto:support@isccredit.com">support@isccredit.com</a>.';

  function succeeded(form) {
    form.hidden = true;
    show(form, 'ok', OK[form.id] || OK._default);
  }

  var forms = document.querySelectorAll('form[action="/api/submit"]');
  Array.prototype.forEach.call(forms, function (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var tok = form.querySelector('[name="cf-turnstile-response"]');
      if (!tok || !tok.value) { show(form, 'err', '<b>One more step.</b>Please complete the security check above the button, then submit again.'); return; }
      var btn = form.querySelector('[type="submit"]'), label = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = 'Sending&hellip;'; }
      var box = document.getElementById((form.id || 'form') + '-status'); if (box) box.hidden = true;
      var ok = false;
      try {
        var res = await fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form), credentials: 'same-origin' });
        ok = res.ok && res.redirected && /[?&]success=true(&|$)/.test(res.url);
      } catch (err) { ok = false; }
      if (ok) {
        ga('lead_form_success', form);
        succeeded(form);
      } else {
        show(form, 'err', ERR);
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
        resetCheck(form);
      }
    });
  });

  // Returning from a normal (no-JavaScript) post: the server adds ?success=true only after a successful send.
  if (forms.length && /[?&]success=true(&|$)/.test(window.location.search)) {
    succeeded(forms[0]);
    try { history.replaceState(null, '', window.location.pathname + window.location.hash); } catch (e) {}
  }

  // Guide download forms
  window.iscGuideStatus = function (form, kind, pdfUrl) {
    if (kind === 'ok') {
      show(form, 'ok', '<b>Thank you. Your guide is downloading.</b>If the download does not start, <a href="' + pdfUrl + '" download>download the guide here</a>.');
    } else {
      show(form, 'err', '<b>We could not process your request.</b>Please try again, or email <a href="mailto:support@isccredit.com">support@isccredit.com</a>.');
      resetCheck(form);
    }
  };
})();

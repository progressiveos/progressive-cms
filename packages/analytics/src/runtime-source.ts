// Public analytics runtime v1 (Analytics spec §6/§9/§13/§14). First-party,
// dependency-free, failure-isolated: every handler is guarded; a blocked or
// broken provider must never break the page. Phone clicks resolve the href
// at click time (event delegation) so call-tracking / dynamic number
// insertion mutations are tracked correctly (§14).

export const ANALYTICS_RUNTIME_SOURCE = String.raw`
(function () {
  "use strict";
  if (window.__pcmsAnalytics) return;
  window.__pcmsAnalytics = true;
  var cfg = window.__PCMS_ANALYTICS_CONFIG__;
  if (!cfg) return;
  var dl = window.dataLayer = window.dataLayer || [];
  var suspended = false;
  function push(event, data) {
    if (suspended) return;
    try {
      var row = {
        event: event,
        pcms_event_version: 1,
        pcms_page_id: cfg.page_id || null,
        pcms_page_type: cfg.page_type || null,
        pcms_locale: cfg.locale || null,
      };
      if (data) for (var k in data) row[k] = data[k];
      dl.push(row);
    } catch (_) {}
  }
  function id(el) {
    try {
      return el.getAttribute("data-pcms-form-id") || el.id || null;
    } catch (_) { return null; }
  }
  try {
    push("pcms_page_view");
    if (cfg.is_search) push("pcms_search");
  } catch (_) {}

  // Only managed, consent-gated providers participate. Immediate providers
  // remain the owner's explicit choice. A loaded script needs a new document
  // to stop its timers/listeners; removing its script element cannot unload it.
  var pending = cfg.deferred || [];
  var active = [];
  var state = { analytics: false, marketing: false };
  function categoryKnown(category) {
    return category === "analytics" || category === "marketing";
  }
  function snapshot() {
    return { analytics: state.analytics, marketing: state.marketing };
  }
  function remember() {
    try {
      window.localStorage.setItem(cfg.consent_key, JSON.stringify({
        version: cfg.consent_version, analytics: state.analytics, marketing: state.marketing
      }));
      return true;
    } catch (_) { return false; }
  }
  try {
    var saved = JSON.parse(window.localStorage.getItem(cfg.consent_key));
    if (saved && saved.version === cfg.consent_version) {
      // Do not restore a grant when this browser cannot persist its revoke.
      window.localStorage.setItem(cfg.consent_key, JSON.stringify(saved));
      state.analytics = saved.analytics === true;
      state.marketing = saved.marketing === true;
    }
  } catch (_) {}
  // If storage failed during revocation, navigation must still override an
  // older grant. Retain the denial marker until the choice can be persisted.
  try {
    var here = new URL(window.location.href);
    var denied = here.searchParams.get("_pcms_consent_revoke");
    if (categoryKnown(denied)) {
      state[denied] = false;
      if (remember()) {
        here.searchParams.delete("_pcms_consent_revoke");
        window.history.replaceState(null, "", here.href);
      }
    }
  } catch (_) {}
  function publishState(category) {
    window.pcmsConsentState = snapshot();
    try {
      window.dispatchEvent(new CustomEvent("pcms:consent", {
        detail: { category: category, state: snapshot() }
      }));
    } catch (_) {}
  }
  function activate(category) {
    if (suspended || !state[category]) return;
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].category !== category || active[i]) continue;
      active[i] = true;
      for (var j = 0; j < pending[i].scripts.length; j++) {
        var inline = document.createElement("script");
        inline.textContent = pending[i].scripts[j];
        document.head.appendChild(inline);
      }
      for (var j = 0; j < pending[i].loaders.length; j++) {
        var script = document.createElement("script");
        script.async = true;
        script.src = pending[i].loaders[j];
        document.head.appendChild(script);
      }
    }
  }
  window.pcmsConsent = {
    grant: function (category) {
      if (!categoryKnown(category) || suspended) return;
      state[category] = true;
      remember();
      try { activate(category); } catch (_) {}
      publishState(category);
    },
    revoke: function (category) {
      if (!categoryKnown(category) || suspended) return;
      state[category] = false;
      var stored = remember();
      var loaded = false;
      for (var i = 0; i < pending.length; i++) {
        if (active[i] && pending[i].category === category) loaded = true;
      }
      if (loaded) suspended = true;
      publishState(category);
      if (loaded) {
        try {
          var target = new URL(window.location.href);
          if (!stored) target.searchParams.set("_pcms_consent_revoke", category);
          window.location.replace(target.href);
        } catch (_) { window.location.reload(); }
      }
    },
    getState: snapshot,
  };
  window.pcmsConsentState = snapshot();
  try { activate("analytics"); activate("marketing"); } catch (_) {}
  // Another tab's revoke applies here too; a grant never overrides an
  // in-progress reset. Storage errors otherwise degrade to page-local choice.
  window.addEventListener("storage", function (event) {
    if (event.key !== cfg.consent_key && event.key !== null) return;
    var next;
    try { next = JSON.parse(event.newValue); } catch (_) {}
    if (!next || next.version !== cfg.consent_version) next = {};
    var reset = false;
    for (var i = 0; i < pending.length; i++) {
      var category = pending[i].category;
      if (active[i] && state[category] && next[category] !== true) reset = true;
    }
    state.analytics = next.analytics === true;
    state.marketing = next.marketing === true;
    if (reset) suspended = true;
    publishState(null);
    if (reset) window.location.reload();
  });

  // Delegated semantic clicks (tel:/mailto:/download/CTA/search results).
  document.addEventListener(
    "click",
    function (ev) {
      try {
        var target = ev.target;
        var a = target && target.closest ? target.closest("a") : null;
        if (!a) return;
        var href = a.getAttribute("href") || "";
        if (href.indexOf("tel:") === 0) {
          push("pcms_phone_click", { link_href: href.slice(0, 200) });
          return;
        }
        if (href.indexOf("mailto:") === 0) {
          push("pcms_email_click", { link_href: href.slice(0, 200) });
          return;
        }
        var cta = a.closest("[data-pcms-cta],[data-cta]");
        if (a.hasAttribute("download")) {
          push("pcms_download", { link_href: href.slice(0, 200) });
          return;
        }
        if (cta) {
          push("pcms_cta_click", {
            block_id: cta.getAttribute("data-pcms-block-id") || null,
            link_href: href.slice(0, 200),
          });
          return;
        }
        if (cfg.is_search && href.charAt(0) === "/") {
          push("pcms_search_result_click", { link_href: href.slice(0, 200) });
        }
      } catch (_) {}
    },
    true,
  );

  // Video lifecycle (delegated media events — no theme coupling).
  document.addEventListener(
    "play",
    function (ev) {
      try {
        if (ev.target && ev.target.tagName === "VIDEO") push("pcms_video_start");
      } catch (_) {}
    },
    true,
  );
  document.addEventListener(
    "ended",
    function (ev) {
      try {
        if (ev.target && ev.target.tagName === "VIDEO") push("pcms_video_complete");
      } catch (_) {}
    },
    true,
  );

  // Forms lifecycle: start/submit from the DOM; success/error from the
  // guarded observer of public intake responses (spec §6 — values are never
  // read; submit !== success).
  var started = [];
  function markStarted(form) {
    for (var i = 0; i < started.length; i++) if (started[i] === form) return true;
    started.push(form);
    return false;
  }
  function formOf(node) {
    try {
      return node && node.closest ? node.closest("form") : null;
    } catch (_) {
      return null;
    }
  }
  document.addEventListener(
    "input",
    function (ev) {
      try {
        var f = formOf(ev.target);
        if (f && !markStarted(f)) push("pcms_form_start", { form_id: id(f) });
      } catch (_) {}
    },
    true,
  );
  document.addEventListener(
    "submit",
    function (ev) {
      try {
        var f = formOf(ev.target);
        if (!f) return;
        var first = !markStarted(f);
        if (first) push("pcms_form_start", { form_id: id(f) });
        push("pcms_form_submit", { form_id: id(f) });
      } catch (_) {}
    },
    true,
  );
  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function () {
        var args = arguments;
        var url = (args[0] && args[0].url) || args[0] || "";
        var method = ((args[1] && args[1].method) || "GET") + "";
        return originalFetch.apply(this, arguments).then(
          function (response) {
            try {
              if (
                method.toUpperCase() === "POST" &&
                typeof url === "string" &&
                url.indexOf("/api/v1/public/") === 0
              ) {
                var f = document.activeElement && document.activeElement.closest ? document.activeElement.closest("form") : null;
                push(response.ok ? "pcms_form_success" : "pcms_form_error", {
                  form_id: f ? id(f) : null,
                });
              }
            } catch (_) {}
            return response;
          },
          function (error) {
            try {
              if (method.toUpperCase() === "POST" && typeof url === "string" && url.indexOf("/api/v1/public/") === 0) {
                push("pcms_form_error", { form_id: null });
              }
            } catch (_) {}
            throw error;
          },
        );
      };
    }
  } catch (_) {}

  // Webvisor privacy markers (spec §6.1): first-party form fields get
  // ym-disable-keys; ym-record-keys is never added by the platform.
  function markPrivacy() {
    try {
      var fields = document.querySelectorAll("form input, form textarea, form select");
      for (var i = 0; i < fields.length; i++) {
        var el = fields[i];
        if (!/\bym-disable-keys\b/.test(el.className)) {
          el.className = (el.className ? el.className + " " : "") + "ym-disable-keys";
        }
      }
    } catch (_) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", markPrivacy);
  } else {
    markPrivacy();
  }
})();
`;

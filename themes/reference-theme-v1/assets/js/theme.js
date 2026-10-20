/* Progressive Reference — public theme behavior.
   Presentation-only: mobile menu toggle, gallery lightbox, client calculator.
   No privileged APIs, no network calls, no dynamic code execution. */
(() => {
  function initMenuToggles() {
    document.querySelectorAll("[data-menu-toggle]").forEach((button) => {
      var nav = document.getElementById(button.getAttribute("aria-controls") || "");
      if (!nav) return;
      button.addEventListener("click", () => {
        const open = nav.getAttribute("data-open") === "true";
        nav.setAttribute("data-open", String(!open));
        button.setAttribute("aria-expanded", String(!open));
      });
    });
  }

  function initLightbox() {
    var gallery = document.querySelector("[data-lightbox]");
    var lightbox = document.querySelector(".lightbox");
    if (!gallery || !lightbox) return;
    var img = lightbox.querySelector("img");
    gallery.addEventListener("click", (event) => {
      var link = event.target.closest("a[data-full]");
      if (!link) return;
      event.preventDefault();
      img.setAttribute("src", link.getAttribute("data-full"));
      img.setAttribute("alt", link.getAttribute("data-alt") || "");
      lightbox.setAttribute("data-open", "true");
      lightbox.querySelector(".lightbox-close").focus();
    });
    function close() {
      lightbox.setAttribute("data-open", "false");
      img.removeAttribute("src");
    }
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox || event.target.closest(".lightbox-close")) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && lightbox.getAttribute("data-open") === "true") close();
    });
  }

  function initCalculators() {
    document.querySelectorAll("[data-calculator]").forEach((root) => {
      var form = root.querySelector("form");
      var output = root.querySelector(".calc-output");
      if (!form || !output) return;
      var formula = root.getAttribute("data-formula") || "";
      var digits = Number(root.getAttribute("data-digits") || "2");
      var unit = root.getAttribute("data-unit") || "";
      function fmt(value) {
        if (!Number.isFinite(value)) return "—";
        return value.toFixed(digits) + (unit ? ` ${unit}` : "");
      }
      function evaluate() {
        var values = {};
        root.querySelectorAll("input, select").forEach((input) => {
          values[input.name] = input.type === "checkbox" ? input.checked : Number(input.value);
        });
        output.textContent = fmt(window.__pcmsCalc ? window.__pcmsCalc(formula, values) : NaN);
      }
      form.addEventListener("input", evaluate);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        evaluate();
      });
      evaluate();
    });
  }

  /* Formula evaluation mirrors the server-side whitelisted grammar:
     numbers, + - * / ^ ( ), variables, min/max/round/ceil/floor/abs.
     A tiny recursive-descent parser — no eval, no Function. */
  const FUNCTIONS = {
    min: Math.min,
    max: Math.max,
    round: Math.round,
    ceil: Math.ceil,
    floor: Math.floor,
    abs: Math.abs,
  };

  const tokenize = (input) => {
    const tokens = [];
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === " ") {
        i++;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        let num = "";
        while (i < input.length && /[0-9.]/.test(input[i])) {
          num += input[i];
          i++;
        }
        tokens.push({ t: "num", v: Number(num) });
        continue;
      }
      if (/[a-z_]/.test(ch)) {
        let name = "";
        while (i < input.length && /[a-z0-9_]/.test(input[i])) {
          name += input[i];
          i++;
        }
        tokens.push({ t: name in FUNCTIONS ? "func" : "var", v: name });
        continue;
      }
      if ("+-*/^(),".includes(ch)) {
        tokens.push({ t: ch });
        i++;
        continue;
      }
      throw new Error(`bad formula character: ${ch}`);
    }
    return tokens;
  };

  window.__pcmsCalc = (formula, values) => {
    const tokens = tokenize(String(formula));
    let pos = 0;
    var peek = () => tokens[pos];
    var next = () => tokens[pos++];
    var parseExpr;
    var parseTerm;
    var parseFactor;
    var parseAtom = () => {
      const token = next();
      if (!token) throw new Error("unexpected end of formula");
      if (token.t === "num") return token.v;
      if (token.t === "var") {
        if (!(token.v in values)) throw new Error(`unknown variable: ${token.v}`);
        return Number(values[token.v]) || 0;
      }
      if (token.t === "func") {
        if (next().t !== "(") throw new Error("expected (");
        const args = [];
        if (peek() && peek().t !== ")") {
          args.push(parseExpr());
          while (peek() && peek().t === ",") {
            next();
            args.push(parseExpr());
          }
        }
        if (next().t !== ")") throw new Error("expected )");
        return FUNCTIONS[token.v].apply(null, args);
      }
      if (token.t === "(") {
        const value = parseExpr();
        if (next().t !== ")") throw new Error("expected )");
        return value;
      }
      if (token.t === "-") return -parseFactor();
      throw new Error("unexpected token");
    };
    parseExpr = () => {
      let left = parseTerm();
      while (peek() && (peek().t === "+" || peek().t === "-")) {
        const op = next().t;
        left = op === "+" ? left + parseTerm() : left - parseTerm();
      }
      return left;
    };
    parseTerm = () => {
      let left = parseFactor();
      while (peek() && (peek().t === "*" || peek().t === "/")) {
        const op = next().t;
        left = op === "*" ? left * parseFactor() : left / parseFactor();
      }
      return left;
    };
    parseFactor = () => {
      const base = parseAtom();
      if (peek() && peek().t === "^") {
        next();
        return base ** parseFactor();
      }
      return base;
    };
    try {
      const result = parseExpr();
      return pos === tokens.length ? result : NaN;
    } catch (_err) {
      return NaN;
    }
  };

  function initVideoFacades() {
    document.querySelectorAll("[data-video-facade]").forEach((facade) => {
      facade.addEventListener("click", () => {
        if (facade.querySelector("iframe")) return;
        const frame = document.createElement("iframe");
        frame.setAttribute("src", facade.getAttribute("data-src"));
        frame.setAttribute("title", "Видео");
        frame.setAttribute("allowfullscreen", "");
        frame.style.width = "100%";
        frame.style.aspectRatio = "16/9";
        frame.style.border = "0";
        facade.textContent = "";
        facade.appendChild(frame);
      });
    });
  }

  // ─── Video modal (video@1 presentation=modal): the overlay is created on
  // click and destroyed on close, so nothing autoplays on page load.
  function initVideoModals() {
    var close = (overlay) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    var onKey = (event) => {
      var overlay = document.querySelector(".video-modal");
      if (overlay !== null && (event.key === "Escape" || event.key === "Esc")) close(overlay);
    };
    document.querySelectorAll("[data-video-modal]").forEach((facade) => {
      facade.addEventListener("click", () => {
        if (document.querySelector(".video-modal") !== null) return;
        var overlay = document.createElement("div");
        overlay.className = "video-modal";
        var inner = document.createElement("div");
        inner.className = "video-modal__body";
        var upload = facade.getAttribute("data-upload");
        if (upload !== null) {
          const video = document.createElement("video");
          video.setAttribute("controls", "");
          video.setAttribute("autoplay", "");
          video.setAttribute("playsinline", "");
          video.src = upload;
          inner.appendChild(video);
        } else {
          const frame = document.createElement("iframe");
          frame.setAttribute("src", facade.getAttribute("data-src"));
          frame.setAttribute("title", "Видео");
          frame.setAttribute("allowfullscreen", "");
          frame.setAttribute("allow", "autoplay; fullscreen");
          inner.appendChild(frame);
        }
        var closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "video-modal__close";
        closeButton.setAttribute("aria-label", "Закрыть");
        closeButton.textContent = "×";
        closeButton.addEventListener("click", () => close(overlay));
        overlay.appendChild(inner);
        overlay.appendChild(closeButton);
        overlay.addEventListener("click", (event) => {
          if (event.target === overlay) close(overlay);
        });
        document.body.appendChild(overlay);
        document.addEventListener("keydown", onKey);
        closeButton.focus();
      });
    });
  }

  // ─── Audio player: the native <audio> element stays the no-JS fallback;
  // when JS runs, custom controls replace it (non-native, animated in the
  // "rich" style via CSS). Server-independent, no external players.
  function initAudioPlayers() {
    document.querySelectorAll("[data-audio-player]").forEach((player) => {
      var audio = player.querySelector("audio");
      if (audio === null) return;
      player.classList.add("audio-player--enhanced");
      audio.removeAttribute("controls");
      var toggle = player.querySelector(".audio-player__toggle");
      var progress = player.querySelector("[data-audio-progress]");
      var bar = player.querySelector("[data-audio-bar]");
      var current = player.querySelector("[data-audio-current]");
      var duration = player.querySelector("[data-audio-duration]");
      var formatTime = (seconds) => {
        if (!isFinite(seconds)) return "--:--";
        var whole = Math.floor(seconds);
        var m = Math.floor(whole / 60);
        var s = whole % 60;
        return m + ":" + (s < 10 ? "0" : "") + s;
      };
      toggle.addEventListener("click", () => {
        if (audio.paused) {
          document.querySelectorAll("[data-audio-player].is-playing audio").forEach((other) => {
            if (other !== audio) other.pause();
          });
          audio.play();
        } else {
          audio.pause();
        }
      });
      audio.addEventListener("play", () => player.classList.add("is-playing"));
      audio.addEventListener("pause", () => player.classList.remove("is-playing"));
      audio.addEventListener("ended", () => {
        player.classList.remove("is-playing");
        if (bar !== null) bar.style.width = "0%";
      });
      audio.addEventListener("timeupdate", () => {
        if (bar !== null && isFinite(audio.duration) && audio.duration > 0) {
          bar.style.width = (audio.currentTime / audio.duration) * 100 + "%";
        }
        if (current !== null) current.textContent = formatTime(audio.currentTime);
      });
      if (duration !== null) {
        audio.addEventListener("loadedmetadata", () => {
          duration.textContent = formatTime(audio.duration);
        });
      }
      progress.addEventListener("click", (event) => {
        var rect = progress.getBoundingClientRect();
        var ratio = (event.clientX - rect.left) / rect.width;
        if (isFinite(audio.duration) && ratio >= 0 && ratio <= 1) {
          audio.currentTime = ratio * audio.duration;
        }
      });
    });
  }

  // ─── Forms & Quizzes (M12): progressive enhancement over the public JSON
  // interaction API. Server stays authoritative; this only decorates.
  // ─── MKT-010 attribution: allowlisted UTM captured once per tab in
  // sessionStorage (no new cookie/identifier). The server validates and
  // freezes this — it is a claim, never a proof of the ad source.
  function attributionSnapshot() {
    var allowed = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    var snap = null;
    try {
      snap = JSON.parse(sessionStorage.getItem("pcms_attribution") || "null");
    } catch {
      snap = null;
    }
    if (snap === null || typeof snap !== "object" || Array.isArray(snap)) snap = null;
    var params = new URLSearchParams(window.location.search);
    var currentUtm = {};
    allowed.forEach((key) => {
      var value = params.get(key);
      if (value) {
        value = value.trim();
        if (value !== "" && value.length <= 120 && !/\p{Cc}/u.test(value)) {
          currentUtm[key] = value;
        }
      }
    });
    var hasUtm = Object.keys(currentUtm).length > 0;
    var hasCapturedUtm =
      snap && allowed.some((key) => typeof snap[key] === "string" && snap[key] !== "");
    if (!snap || (hasUtm && !hasCapturedUtm)) {
      snap = {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_content: null,
        utm_term: null,
        landing_path: window.location.pathname,
        referrer_host: null,
      };
      allowed.forEach((key) => {
        if (currentUtm[key]) snap[key] = currentUtm[key];
      });
      let ref;
      try {
        ref = new URL(document.referrer || "about:blank");
        if (ref.hostname && ref.hostname !== window.location.hostname)
          snap.referrer_host = ref.hostname;
      } catch {}
      try {
        sessionStorage.setItem("pcms_attribution", JSON.stringify(snap));
      } catch {}
    }
    return snap;
  }

  function formValues(formElement) {
    var values = {};
    new FormData(formElement).forEach((value, key) => {
      if (value === "") return;
      if (values[key] === undefined) {
        values[key] = value;
      } else if (Array.isArray(values[key])) {
        values[key].push(value);
      } else {
        values[key] = [values[key], value];
      }
    });
    // The submit API takes typed JSON: checkbox/consent fields carry booleans,
    // checkbox_group an array of option values — raw FormData strings fail
    // server validation ("must be a boolean").
    formElement.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      if (!input.name) return;
      var group = formElement.querySelectorAll('input[type="checkbox"][name="' + input.name + '"]');
      if (group.length > 1) {
        const picked = [];
        group.forEach((box) => {
          if (box.checked && box.value !== "") picked.push(box.value);
        });
        values[input.name] = picked;
      } else {
        values[input.name] = input.checked;
      }
    });
    return values;
  }

  function showFormErrors(formElement, violations) {
    formElement.querySelectorAll("[data-error-for]").forEach((node) => {
      node.hidden = true;
      node.textContent = "";
    });
    (violations || []).forEach((violation) => {
      var target = formElement.querySelector(`[data-error-for="${violation.key}"]`);
      if (target) {
        target.textContent = violation.message;
        target.hidden = false;
      }
    });
  }

  function initForms() {
    document.querySelectorAll("form[data-pcms-form]").forEach((formElement) => {
      formElement.addEventListener("submit", (event) => {
        event.preventDefault();
        var status = formElement.querySelector("[data-form-status]");
        var values = formValues(formElement);
        var token = formElement.getAttribute("data-submission-token");
        var payload = token ? { values: values, submission_token: token } : { values: values };
        // Server-side lead attribution: the page the visitor submitted from
        // (top-level body field, never inside values).
        payload.source_url = window.location.href;
        payload.attribution = attributionSnapshot();
        fetch(formElement.getAttribute("action"), {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then((response) => response.json().then((body) => ({ ok: response.ok, body: body })))
          .then((result) => {
            if (result.ok) {
              showFormErrors(formElement, []);
              if (status) {
                status.textContent = result.body.success?.message || "Отправлено";
                status.hidden = false;
              }
              formElement.querySelectorAll("input, textarea, select, button").forEach((node) => {
                node.disabled = true;
              });
            } else {
              showFormErrors(formElement, result.body.error?.details?.violations || []);
            }
          })
          .catch(() => {
            if (status) {
              status.textContent = "Не удалось отправить, попробуйте позже";
              status.hidden = false;
            }
          });
      });
    });
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }

  function renderQuizStep(body, step) {
    var html = step.title ? `<h3 class="block-quiz__step">${escapeHtml(step.title)}</h3>` : "";
    step.questions.forEach((question) => {
      html +=
        '<fieldset class="form-field" data-question="' +
        escapeHtml(question.id) +
        '"><legend>' +
        escapeHtml(question.label) +
        "</legend>";
      (question.options || []).forEach((option) => {
        var inputType = question.type === "multiple_choice" ? "checkbox" : "radio";
        html +=
          '<label class="form-check"><input type="' +
          inputType +
          '" name="' +
          escapeHtml(question.id) +
          '" value="' +
          escapeHtml(option.value) +
          '"><span>' +
          escapeHtml(option.label) +
          "</span></label>";
      });
      if (question.type === "text") {
        html += `<input class="form-input" name="${escapeHtml(question.id)}" type="text">`;
      } else if (question.type === "number") {
        html += `<input class="form-input" name="${escapeHtml(question.id)}" type="number">`;
      } else if (question.type === "boolean") {
        html +=
          '<label class="form-check"><input type="checkbox" name="' +
          escapeHtml(question.id) +
          '" value="true"><span>Да</span></label>';
      }
      html += "</fieldset>";
    });
    html += '<button class="button button--primary" type="button" data-quiz-next>Далее</button>';
    body.innerHTML = html;
  }

  function initQuizzes() {
    document.querySelectorAll("[data-pcms-quiz]").forEach((root) => {
      var startUrl = root.getAttribute("data-quiz-start");
      var answerUrl = root.getAttribute("data-quiz-answer");
      var completeUrl = root.getAttribute("data-quiz-complete");
      var body = root.querySelector("[data-quiz-body]");
      var status = root.querySelector("[data-quiz-status]");
      var run = null;
      var step = null;

      function showStatus(text) {
        if (status) {
          status.textContent = text;
          status.hidden = false;
        }
      }

      function post(url, payload) {
        return fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then((response) =>
          response.json().then((parsed) => ({ ok: response.ok, body: parsed })),
        );
      }

      function answerValues() {
        var values = {};
        new FormData(body.querySelector("fieldset") ? body : root).forEach((value, key) => {
          if (value === "") return;
          if (values[key] === undefined) values[key] = value;
          else if (Array.isArray(values[key])) values[key].push(value);
          else values[key] = [values[key], value];
        });
        return values;
      }

      if (!startUrl || !body) return;
      var startButton = document.createElement("button");
      startButton.className = "button button--primary";
      startButton.type = "button";
      startButton.textContent = root.getAttribute("data-start-label") || "Начать";
      startButton.addEventListener("click", () => {
        post(startUrl, { attribution: attributionSnapshot() }).then((result) => {
          if (!result.ok) {
            showStatus("Квиз недоступен");
            return;
          }
          run = result.body;
          step = result.body.step;
          // Run-scoped endpoints carry a {quiz_run_id} placeholder in the
          // view model; substitute it once the run exists.
          answerUrl = answerUrl.replace("{quiz_run_id}", run.quiz_run_id);
          completeUrl = completeUrl.replace("{quiz_run_id}", run.quiz_run_id);
          renderQuizStep(body, step);
        });
      });
      body.appendChild(startButton);

      body.addEventListener("click", (event) => {
        if (!event.target.matches("[data-quiz-next]") || !run || !step) return;
        var questionId = step.questions.length > 0 ? step.questions[0].id : null;
        // Multi-question steps submit one answer per call (server-driven flow).
        var values = answerValues();
        var value = questionId ? values[questionId] : undefined;
        post(answerUrl, {
          quiz_run_id: run.quiz_run_id,
          resume_token: run.resume_token,
          question_id: questionId,
          value: value,
        }).then((result) => {
          if (!result.ok) {
            showStatus(result.body.error?.message || "Ошибка");
            return;
          }
          if (result.body.next_step) {
            step = result.body.next_step;
            renderQuizStep(body, step);
          } else {
            return post(completeUrl, {
              quiz_run_id: run.quiz_run_id,
              resume_token: run.resume_token,
            }).then((done) => {
              if (done.ok && done.body.outcome) {
                body.innerHTML =
                  "<h3>" +
                  escapeHtml(done.body.outcome.title) +
                  "</h3><p>" +
                  escapeHtml(done.body.outcome.description || "") +
                  "</p>";
              } else if (!done.ok) {
                showStatus(done.body.error?.message || "Ошибка");
              }
            });
          }
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Capture the landing page before navigation can remove its UTM query.
    attributionSnapshot();
    initMenuToggles();
    initLightbox();
    initCalculators();
    initVideoFacades();
    initVideoModals();
    initAudioPlayers();
    initForms();
    initQuizzes();
  });
})();

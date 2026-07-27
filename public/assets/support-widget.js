/**
 * Garden customer-support chat widget.
 * Drop <script src="/assets/support-widget.js"></script> on any page.
 * Renders a floating launcher + chat panel wired to /api/support/*.
 */
(function () {
  if (window.__tzSupportWidget) return;
  window.__tzSupportWidget = true;

  const T = (k, p) => (window.TZShop ? window.TZShop.t(k, p) : k);
  const esc = (s) => (window.TZShop ? window.TZShop.esc(s) : String(s));
  const api = (path, opt = {}) =>
    window.TZShop ? window.TZShop.apiFetch(path, opt) : fetch(path, { credentials: "same-origin", ...opt });

  let open = false;
  let authed = null;
  let pollTimer = null;
  let lastCount = 0;
  let renderedIds = new Set();

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "ts-support-fab";
  fab.setAttribute("aria-label", "Customer support chat");
  fab.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
    '<span class="ts-support-fab__label" data-i18n="support.fab">Support</span>' +
    '<span class="ts-support-fab__badge" id="tzSupportBadge"></span>';

  const panel = document.createElement("div");
  panel.className = "ts-support-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Customer support");
  panel.innerHTML =
    '<div class="ts-support-head">' +
    '<div class="ts-support-head__avatar">🌿</div>' +
    '<div><strong data-i18n="support.title">Garden Support</strong><span data-i18n="support.subtitle">We usually reply within minutes</span></div>' +
    '<button type="button" class="ts-support-head__close" id="tzSupportClose" aria-label="Close">&times;</button>' +
    "</div>" +
    '<div class="ts-support-body" id="tzSupportBody"></div>' +
    '<div class="ts-support-foot">' +
    '<textarea id="tzSupportInput" rows="1" placeholder="" data-i18n-placeholder="support.placeholder"></textarea>' +
    '<button type="button" id="tzSupportSend" data-i18n="support.send">Send</button>' +
    "</div>";

  function mount() {
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    if (window.TZShop && window.TZShop.applyDataI18n) window.TZShop.applyDataI18n(panel);
    if (window.TZShop && window.TZShop.applyDataI18n) window.TZShop.applyDataI18n(fab);

    fab.addEventListener("click", toggle);
    panel.querySelector("#tzSupportClose").addEventListener("click", () => setOpen(false));
    const input = panel.querySelector("#tzSupportInput");
    const send = panel.querySelector("#tzSupportSend");
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "2.6rem";
      input.style.height = Math.min(96, input.scrollHeight) + "px";
    });
  }

  function toggle() {
    setOpen(!open);
  }

  async function setOpen(next) {
    open = next;
    panel.classList.toggle("on", open);
    if (open) {
      await loadThread();
      await api("/api/support/read", { method: "POST", body: "{}" }).catch(() => {});
      setBadge(0);
      const input = panel.querySelector("#tzSupportInput");
      if (input) input.focus();
    }
  }

  function setBadge(n) {
    const b = panel.parentNode ? document.getElementById("tzSupportBadge") : null;
    if (!b) return;
    if (n > 0) {
      b.textContent = n > 9 ? "9+" : String(n);
      b.classList.add("on");
    } else {
      b.classList.remove("on");
    }
  }

  function renderMessages(messages) {
    const body = document.getElementById("tzSupportBody");
    if (!body) return;
    body.innerHTML = messages
      .map((m) => {
        const role = m.sender_role === "user" ? "user" : m.sender_role === "system" ? "system" : "admin";
        const when = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
        const name =
          role === "admin"
            ? `<strong style="display:block;font-size:0.72rem;opacity:0.8">${esc(m.sender_name || "Support")}</strong>`
            : "";
        const del =
          role === "user"
            ? `<button type="button" class="ts-support-msg__del" data-del="${esc(m.id)}" title="${esc(
                T("support.delete")
              )}" aria-label="${esc(T("support.delete"))}">&times;</button>`
            : "";
        return `<div class="ts-support-msg ts-support-msg--${role}" data-mid="${esc(m.id)}">${del}${name}${esc(
          m.body
        )}<time>${when}</time></div>`;
      })
      .join("");
    body.scrollTop = body.scrollHeight;
    renderedIds = new Set(messages.map((m) => m.id));
    body.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-del");
        if (!id) return;
        if (!confirm(T("support.deleteConfirm"))) return;
        const r = await api(`/api/support/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (window.TZShop) window.TZShop.showToast(j.error || T("support.deleteFail"), "err");
          return;
        }
        await loadThread();
      });
    });
  }

  function renderSignedOut() {
    const body = document.getElementById("tzSupportBody");
    if (!body) return;
    const next = encodeURIComponent(location.pathname + location.search);
    body.innerHTML =
      `<div class="ts-support-msg ts-support-msg--system">${esc(T("support.signinPrompt"))}</div>` +
      `<div style="text-align:center;margin-top:0.5rem"><a class="btn btn--primary btn--sm" href="/shop?auth=signin&next=${next}">${esc(T("support.signinBtn"))}</a></div>`;
    const foot = panel.querySelector(".ts-support-foot");
    if (foot) foot.style.display = "none";
  }

  async function loadThread() {
    const r = await api("/api/support/thread");
    if (r.status === 401) {
      authed = false;
      renderSignedOut();
      return;
    }
    authed = true;
    const foot = panel.querySelector(".ts-support-foot");
    if (foot) foot.style.display = "";
    const j = await r.json().catch(() => ({}));
    renderMessages(j.messages || []);
  }

  async function submit() {
    const input = panel.querySelector("#tzSupportInput");
    const send = panel.querySelector("#tzSupportSend");
    const body = (input.value || "").trim();
    if (!body) return;
    send.disabled = true;
    const r = await api("/api/support/messages", { method: "POST", body: JSON.stringify({ body }) });
    send.disabled = false;
    if (r.status === 401) {
      renderSignedOut();
      return;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (window.TZShop) window.TZShop.showToast(j.error || "Could not send message", "err");
      return;
    }
    input.value = "";
    input.style.height = "2.6rem";
    await loadThread();
  }

  async function poll() {
    try {
      const r = await api("/api/support/thread");
      if (r.status === 401) {
        authed = false;
        setBadge(0);
        return;
      }
      authed = true;
      const j = await r.json().catch(() => ({}));
      const msgs = j.messages || [];
      if (open) {
        // Only re-render if there are new messages
        const ids = new Set(msgs.map((m) => m.id));
        let changed = ids.size !== renderedIds.size;
        if (!changed) {
          for (const id of ids) if (!renderedIds.has(id)) { changed = true; break; }
        }
        if (changed) renderMessages(msgs);
        await api("/api/support/read", { method: "POST", body: "{}" }).catch(() => {});
        setBadge(0);
      } else {
        const unread = j.conversation ? j.conversation.unread_for_user || 0 : 0;
        setBadge(unread);
      }
      lastCount = msgs.length;
    } catch (_) {}
  }

  function start() {
    mount();
    poll();
    pollTimer = setInterval(poll, 5000);
    if (window.TZShop && window.TZShop.onLangChange) {
      window.TZShop.onLangChange(() => {
        if (window.TZShop.applyDataI18n) {
          window.TZShop.applyDataI18n(panel);
          window.TZShop.applyDataI18n(fab);
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

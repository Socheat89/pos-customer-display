/**
 * app.js — POS Customer Display Client Logic
 * -------------------------------------------
 * State machine: IDLE ➜ PENDING ➜ SUCCESS ➜ IDLE
 *
 * - Polls /api/status every ~1100ms
 * - Renders KHQR QR code via qrcode.js
 * - Handles state transitions without UI glitches or memory leaks
 */

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────
  const POLL_INTERVAL_MS = 250;
  const SUCCESS_RESET_MS = 5000;

  // Read ?store= from URL — each display screen has its own store ID.
  // Example: https://your-app.vercel.app?store=pos_48002
  const STORE_ID = new URLSearchParams(window.location.search).get("store") || "pos_default";

  // Append store param to every API call
  const STATUS_ENDPOINT = `/api/status?store=${encodeURIComponent(STORE_ID)}`;
  const RESET_ENDPOINT  = `/api/reset?store=${encodeURIComponent(STORE_ID)}`;


  // ── State ───────────────────────────────────────────────────
  let currentState      = "IDLE";  // 'IDLE' | 'PENDING' | 'SUCCESS'
  let pollTimer         = null;
  let successTimer      = null;
  let isTransitioning   = false;
  let isPolling         = false;
  let lastRenderedJson  = "";
  let lastRenderedQr    = "";

  // ── DOM References ──────────────────────────────────────────
  const screens = {
    idle:    document.getElementById("screen-idle"),
    pending: document.getElementById("screen-pending"),
    success: document.getElementById("screen-success"),
  };

  const els = {
    // Left panel
    orderRefChip:   document.getElementById("order-ref-chip"),
    itemsList:      document.getElementById("items-list"),
    totalAmount:    document.getElementById("total-amount"),
    totalCurrency:  document.getElementById("total-currency"),

    // Right panel (KHQR)
    qrContainer:    document.getElementById("qr-container"),
    amountValue:    document.getElementById("amount-value"),
    amountCurrency: document.getElementById("amount-currency-tag"),
    orderRefBadge:  document.getElementById("order-ref-badge-text"),

    // Success
    countdownText:  document.getElementById("countdown-text"),
  };

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Formats a numeric amount to locale string with 2 decimal places.
   * @param {number} amount
   * @returns {string}
   */
  function formatAmount(amount) {
    return Number(amount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /**
   * Returns currency symbol for display.
   * @param {string} currency  e.g. 'USD', 'KHR', 'EUR'
   * @returns {string}  e.g. '$', '៛', '€'
   */
  function currencySymbol(currency) {
    const map = { USD: '$', KHR: '៛', EUR: '€', THB: '฿', SGD: 'S$', GBP: '£' };
    return map[(currency || 'USD').toUpperCase()] || '$';
  }

  /**
   * Shows one screen, hides others. Uses CSS opacity + pointer-events.
   * @param {'idle'|'pending'|'success'} name
   */
  function showScreen(name) {
    Object.keys(screens).forEach((key) => {
      if (key === name) {
        screens[key].classList.remove("hidden");
      } else {
        screens[key].classList.add("hidden");
      }
    });
  }

  // ── QR Code Rendering ────────────────────────────────────────

  /**
   * Renders a KHQR QR code into #qr-container.
   * Clears any previous QR before rendering.
   * @param {string|null} qrString
   */
  function renderQRCode(qrString) {
    const container = els.qrContainer;

    // Clear previous contents
    container.innerHTML = "";

    if (!qrString) {
      container.innerHTML = `
        <div class="qr-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/>
          </svg>
          <p>QR code will<br>appear here</p>
        </div>`;
      return;
    }

    // Direct Base64 Image support (e.g. ABA PayWay qrImage)
    if (typeof qrString === "string" && (qrString.startsWith("data:image/") || qrString.startsWith("http://") || qrString.startsWith("https://"))) {
      const img = document.createElement("img");
      img.src = qrString;
      img.alt = "ABA KHQR Payment Code";
      img.style.width = "340px";
      img.style.height = "340px";
      img.onerror = () => {
        container.innerHTML = `<div class="qr-placeholder"><p>QR unavailable</p></div>`;
      };
      container.appendChild(img);
      return;
    }

    // 1. Primary: Try qrcode.js with CorrectLevel.L (handles up to 154 chars)
    try {
      new QRCode(container, {
        text:           qrString,
        width:          340,
        height:         340,
        colorDark:      "#000000",
        colorLight:     "#ffffff",
        correctLevel:   QRCode.CorrectLevel.L,
      });
      return;
    } catch (err) {
      console.warn("[QR] qrcode.js overflow/error, switching to fallback renderer:", err);
      container.innerHTML = "";
    }

    // 2. Secondary: High-reliability QR Image endpoint fallback
    const img = document.createElement("img");
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=340x340&data=${encodeURIComponent(qrString)}`;
    img.alt = "ABA KHQR Payment Code";
    img.style.width = "340px";
    img.style.height = "340px";
    img.onerror = () => {
      container.innerHTML = `<div class="qr-placeholder"><p>QR unavailable</p></div>`;
    };
    container.appendChild(img);
  }

  // ── Item List Rendering ───────────────────────────────────────

  /**
   * Cleans item name by stripping leading quantity digits and newlines (e.g. "2\n150-បូ..." -> "150-បូ...")
   * @param {string} name
   * @returns {string}
   */
  function cleanItemName(name) {
    if (!name) return "—";
    return String(name).replace(/^\d+\s*[\r\n]+/, "").trim();
  }

  /**
   * Renders the items list into the left panel.
   * @param {Array<{name: string, qty: number, price: number}>} items
   * @param {string} currency
   */
  function renderItems(items, currency) {
    const list = els.itemsList;
    list.innerHTML = "";

    if (!items || items.length === 0) {
      list.innerHTML = `
        <div style="padding: 24px 12px; text-align: center; color: #6C757D; font-size: 0.9rem;">
          No items in this order.
        </div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    const sym = currencySymbol(currency);

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "item-row";

      const cleanName = cleanItemName(item.name);
      const itemQty   = Number(item.qty || 1);
      const itemPrice = Number(item.price || 0);
      const lineTotal = item.line_total !== undefined ? Number(item.line_total) : itemPrice;
      const unitLabel = item.uom || item.unit || item.uom_name || item.product_uom || 'ដើម';
      const unitPrice = itemQty > 0 ? (lineTotal / itemQty) : lineTotal;

      row.innerHTML = `
        <div class="item-main-info">
          <div class="item-name" title="${escapeHtml(cleanName)}">${escapeHtml(cleanName)}</div>
          <div class="item-sub-detail">
            <span class="item-qty-badge">${itemQty}</span> × ${sym} ${formatAmount(unitPrice)} / ${escapeHtml(unitLabel)}
          </div>
        </div>
        <div class="item-line-total">${sym} ${formatAmount(lineTotal)}</div>
      `;

      fragment.appendChild(row);
    });

    list.appendChild(fragment);
  }

  /**
   * Minimal HTML escaping to prevent XSS from Odoo payload.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── State Transitions ─────────────────────────────────────────

  /**
   * Transition to IDLE — Welcome screen.
   */
  function toIdle() {
    if (currentState === "IDLE") return;
    console.log("[app] → IDLE");
    currentState      = "IDLE";
    lastRenderedJson  = "";
    lastRenderedQr    = "";
    isTransitioning   = false;
    clearTimeout(successTimer);
    showScreen("idle");
  }

  /**
   * Transition to PENDING — split screen with order + KHQR.
   * @param {object} data  API /status response
   */
  function toPending(data) {
    console.log("[app] → PENDING", data.reference, "items:", (data.items || []).length, "total:", data.amount_total, "show_qr:", data.show_qr);
    currentState = "PENDING";

    // Update left panel
    if (els.orderRefChip) {
      els.orderRefChip.textContent = data.reference || "—";
    }
    renderItems(data.items || [], data.currency);

    // Update total bar
    const sym = currencySymbol(data.currency);
    if (els.totalAmount) {
      els.totalAmount.textContent = `${sym} ${formatAmount(data.amount_total || 0)}`;
    }
    if (els.totalCurrency) {
      els.totalCurrency.textContent = '';
    }

    // Update ABA KHQR Modal Card fields
    if (els.amountValue) {
      // Just the number as in screenshot: e.g. "600.00"
      els.amountValue.textContent = formatAmount(data.amount_total || 0);
    }
    if (els.amountCurrency) {
      els.amountCurrency.textContent = (data.currency || "USD").toUpperCase();
    }
    const merchantEl = document.getElementById("khqr-ticket-merchant");
    if (merchantEl) {
      merchantEl.textContent = data.merchant_name || "SK STORE";
    }

    // Center badge in QR ($ or ៛)
    const qrBadge = document.getElementById("qr-center-badge");
    if (qrBadge) {
      qrBadge.textContent = (data.currency || "USD").toUpperCase() === "KHR" ? "៛" : "$";
    }

    // Toggle ABA KHQR Modal Overlay visibility based on show_qr flag
    const khqrModal = document.getElementById("khqr-modal-overlay");
    const showQR = data.show_qr === true || data.is_payment === true || data.payment_mode === true;

    if (khqrModal) {
      if (showQR) {
        // Render QR code
        if (data.qr_string && data.qr_string !== lastRenderedQr) {
          lastRenderedQr = data.qr_string;
          renderQRCode(data.qr_string);
        }
        khqrModal.classList.remove("hidden-modal");
      } else {
        khqrModal.classList.add("hidden-modal");
      }
    }

    showScreen("pending");
  }

  /**
   * Transition to SUCCESS — full-screen confirmation overlay.
   * Auto-resets to IDLE after SUCCESS_RESET_MS.
   */
  function toSuccess() {
    if (isTransitioning) return;
    isTransitioning = true;
    console.log("[app] → SUCCESS");
    currentState      = "SUCCESS";
    lastDataSignature = "";

    showScreen("success");

    // Countdown display
    let secondsLeft = Math.ceil(SUCCESS_RESET_MS / 1000);
    if (els.countdownText) {
      els.countdownText.textContent = `Returning in ${secondsLeft}s…`;
    }

    const countdownInterval = setInterval(() => {
      secondsLeft--;
      if (els.countdownText) {
        els.countdownText.textContent =
          secondsLeft > 0 ? `Returning in ${secondsLeft}s…` : "Returning…";
      }
    }, 1000);

    successTimer = setTimeout(async () => {
      clearInterval(countdownInterval);
      // Reset only this store's session so the display returns to IDLE
      try {
        await fetch(RESET_ENDPOINT, { method: "POST" });
      } catch (_) { /* non-critical */ }
      toIdle();
    }, SUCCESS_RESET_MS);
  }

  // ── Polling ───────────────────────────────────────────────────

  /**
   * Single poll cycle — fetches /api/status and drives state machine.
   */
  async function poll() {
    if (isPolling) return;
    isPolling = true;

    try {
      const url  = `${STATUS_ENDPOINT}&_t=${Date.now()}`;
      const res  = await fetch(url, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const incoming = (data.status || "IDLE").toUpperCase();

      // ── Debug log (visible in browser DevTools Console) ──
      console.debug(`[poll] store=${STORE_ID} status=${incoming}`,
        incoming !== "IDLE" ? `ref=${data.reference} total=${data.amount_total} show_qr=${data.show_qr}` : '');

      switch (incoming) {
        case "IDLE":
          if (currentState !== "IDLE") toIdle();
          break;

        case "ACTIVE":
        case "PENDING": {
          const showQR = Boolean(data.show_qr || data.is_payment || data.payment_mode);
          const currentJson = JSON.stringify({
            status: incoming,
            ref: data.reference || '',
            total: Number(data.amount_total || 0),
            items: data.items || [],
            show_qr: showQR,
            qr: data.qr_string || '',
            updated: data.updated_at || 0
          });

          if (currentState !== "PENDING" || currentJson !== lastRenderedJson) {
            lastRenderedJson = currentJson;
            toPending(data);
          }
          break;
        }

        case "SUCCESS":
        case "PAID":
          if (currentState !== "SUCCESS") toSuccess();
          break;

        default:
          console.warn("[poll] Unknown status:", incoming, data);
      }
    } catch (err) {
      console.warn("[app] Poll error:", err.message);
    } finally {
      isPolling = false;
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────

  function startPolling() {
    // Run immediately, then on interval
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function init() {
    // All screens start hidden except idle
    showScreen("idle");
    currentState = "IDLE";

    // Show active store on idle screen so staff can verify correct store
    const storeEl = document.getElementById("idle-store-indicator");
    if (storeEl) {
      storeEl.textContent = `Store: ${STORE_ID}`;
      storeEl.style.display = STORE_ID !== "default" ? "block" : "none";
    }

    // Setup close button on KHQR modal
    const closeBtn = document.getElementById("khqr-modal-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        const modal = document.getElementById("khqr-modal-overlay");
        if (modal) modal.classList.add("hidden-modal");
      });
    }

    startPolling();
    console.log(`[app] Initialised — store=${STORE_ID} | polling every ${POLL_INTERVAL_MS}ms | endpoint=${STATUS_ENDPOINT}`);
  }

  // DOM ready guard
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Cleanup on page unload (prevents memory leaks in kiosk/embedded tabs)
  window.addEventListener("beforeunload", () => {
    clearInterval(pollTimer);
    clearTimeout(successTimer);
  });
})();

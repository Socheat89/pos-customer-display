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
  const POLL_INTERVAL_MS   = 1100;
  const SUCCESS_RESET_MS   = 5000;
  const STATUS_ENDPOINT    = "/api/status";

  // ── State ───────────────────────────────────────────────────
  let currentState    = "IDLE";  // 'IDLE' | 'PENDING' | 'SUCCESS'
  let pollTimer       = null;
  let successTimer    = null;
  let isTransitioning = false;

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
      // Show placeholder when no QR string available
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

    try {
      // qrcode.js creates a canvas element inside the container
      new QRCode(container, {
        text:           qrString,
        width:          180,
        height:         180,
        colorDark:      "#000000",
        colorLight:     "#ffffff",
        correctLevel:   QRCode.CorrectLevel.M,
      });
    } catch (err) {
      console.error("[QR] Failed to render QR code:", err);
      container.innerHTML = `<div class="qr-placeholder"><p>QR unavailable</p></div>`;
    }
  }

  // ── Item List Rendering ───────────────────────────────────────

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
        <div style="padding: 24px 12px; text-align: center; color: var(--gray-500); font-size: 0.85rem;">
          No items in this order.
        </div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    const sym = currencySymbol(currency);

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "item-row";

      const itemPrice = Number(item.price || 0);
      const itemQty   = Number(item.qty || 1);
      // Support multiple field names Odoo may send for unit of measure
      const unitLabel = item.uom || item.unit || item.uom_name || item.product_uom || '';

      row.innerHTML = `
        <span class="item-name" title="${escapeHtml(item.name || "")}">${escapeHtml(item.name || "—")}</span>
        <span class="item-qty">
          ×${itemQty}${unitLabel ? `<small class="item-unit">${escapeHtml(unitLabel)}</small>` : ''}
        </span>
        <span class="item-price">${sym}${formatAmount(itemPrice * itemQty)}</span>
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
    currentState    = "IDLE";
    isTransitioning = false;
    clearTimeout(successTimer);
    showScreen("idle");
  }

  /**
   * Transition to PENDING — split screen with order + KHQR.
   * @param {object} data  API /status response
   */
  function toPending(data) {
    console.log("[app] → PENDING", data.reference);
    currentState = "PENDING";

    // Update left panel
    if (els.orderRefChip) {
      els.orderRefChip.textContent = data.reference || "—";
    }
    renderItems(data.items || [], data.currency);

    // Update total bar
    const sym = currencySymbol(data.currency);
    if (els.totalAmount) {
      els.totalAmount.textContent = sym + formatAmount(data.amount_total || 0);
    }
    if (els.totalCurrency) {
      // Currency label is now embedded in the amount via symbol — clear text
      els.totalCurrency.textContent = '';
    }

    // Update KHQR inner card
    if (els.amountValue) {
      els.amountValue.textContent = sym + formatAmount(data.amount_total || 0);
    }
    if (els.amountCurrency) {
      els.amountCurrency.textContent = '';
    }
    if (els.orderRefBadge) {
      els.orderRefBadge.textContent = data.reference || "—";
    }

    // Render QR code
    renderQRCode(data.qr_string || null);

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
    currentState = "SUCCESS";

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
      // Reset state on the server so the display goes back to IDLE
      try {
        await fetch("/api/reset", { method: "POST" });
      } catch (_) { /* non-critical */ }
      toIdle();
    }, SUCCESS_RESET_MS);
  }

  // ── Polling ───────────────────────────────────────────────────

  /**
   * Single poll cycle — fetches /api/status and drives state machine.
   */
  async function poll() {
    try {
      const res  = await fetch(STATUS_ENDPOINT, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const incoming = (data.status || "IDLE").toUpperCase();

      switch (incoming) {
        case "IDLE":
          if (currentState !== "IDLE") toIdle();
          break;

        case "PENDING":
          // Only re-render if just entering PENDING or reference changed
          if (
            currentState !== "PENDING" ||
            (els.orderRefChip && els.orderRefChip.textContent !== data.reference)
          ) {
            toPending(data);
          }
          break;

        case "SUCCESS":
          if (currentState !== "SUCCESS") toSuccess();
          break;

        default:
          console.warn("[app] Unknown status:", incoming);
      }
    } catch (err) {
      // Silently swallow network errors — display keeps last good state
      console.warn("[app] Poll error:", err.message);
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
    startPolling();
    console.log("[app] POS Customer Display initialised. Polling every", POLL_INTERVAL_MS, "ms.");
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

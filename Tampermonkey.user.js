// ==UserScript==
// @name         Odoo POS Dynamic Store Extractor & Popup KHQR Sync
// @namespace    http://tampermonkey.net/
// @version      11.0
// @description  Auto-detect POS Session/Store ID and Sync to Vercel with Popup KHQR on Payment
// @author       Doem Socheat
// @match        *://skco-test-saas19-0917.odoo.com/*
// @match        *://*.odoo.com/pos/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      pos-customer-display.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ── Configuration ──────────────────────────────────────────
    const win         = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const VERCEL_BASE = 'https://pos-customer-display.vercel.app';
    const VERCEL_API  = `${VERCEL_BASE}/api/order`;

    // ── Persistent Cache across screen switches ────────────────
    let lastKey          = '';
    let isCurrentlyReset = false;
    let cachedItems      = [];
    let cachedTotal      = 0;
    let cachedRef        = '';

    /**
     * ស្វែងរក Object pos របស់ Odoo POS (OWL Framework & Legacy)
     */
    function getOdooPos() {
        try {
            // 1. Check direct global posmodel
            if (win.posmodel && typeof win.posmodel.get_order === 'function') {
                return win.posmodel;
            }
            // 2. Check Odoo OWL Debug Services
            if (win.__WOWL_DEBUG__?.root?.env?.services?.pos) {
                return win.__WOWL_DEBUG__.root.env.services.pos;
            }
            if (win.odoo?.__WOWL_DEBUG__?.root?.env?.services?.pos) {
                return win.odoo.__WOWL_DEBUG__.root.env.services.pos;
            }
        } catch (_) {}

        // 3. Scan DOM elements for OWL Component instance
        const candidateSelectors = [
            '.pos', '.point-of-sale', '.pos-content',
            '.payment-screen', '.product-screen', '#pos-app',
            '.pos-topheader', '.order-widget'
        ];

        for (const sel of candidateSelectors) {
            const el = document.querySelector(sel);
            if (!el) continue;

            if (win.owl?.Component?.getComponent) {
                try {
                    const comp = win.owl.Component.getComponent(el);
                    const p = comp?.pos || comp?.env?.services?.pos || comp?.env?.pos;
                    if (p && typeof p.get_order === 'function') return p;
                } catch (_) {}
            }

            if (el.__owl__?.component) {
                const comp = el.__owl__.component;
                const p = comp.pos || comp.env?.services?.pos || comp.env?.pos;
                if (p && typeof p.get_order === 'function') return p;
            }
        }
        return null;
    }

    /**
     * អនុគមន៍ចាប់យកលេខសម្គាល់ POS (ឧ. pos_18, pos_48002)
     */
    function getStoreId() {
        const pos = getOdooPos();
        if (pos && pos.config && pos.config.id) {
            return 'pos_' + pos.config.id;
        }

        const urlMatch = window.location.pathname.match(/\/pos\/(?:ui|web)\/(\d+)\//i);
        if (urlMatch) {
            return 'pos_' + urlMatch[1];
        }

        const headerElements = document.querySelectorAll('.pos-topheader *, button, header div, .pos-branding *');
        for (let el of headerElements) {
            const txt = (el.innerText || '').trim();
            if (/^\d{1,6}$/.test(txt)) {
                return 'pos_' + txt;
            }
        }

        return 'pos_default';
    }

    /**
     * ត្រួតពិនិត្យថា Cashier ស្ថិតលើផ្ទាំង Payment ឬអត់
     */
    function isPaymentScreenActive() {
        // ១. ពិនិត្យតាម Odoo POS JS Model
        try {
            const pos = getOdooPos();
            if (pos) {
                if (pos.mainScreen?.name === 'PaymentScreen') return true;
                const currentOrder = pos.get_order?.();
                if (currentOrder) {
                    const screenData = currentOrder.get_screen_data?.() || currentOrder.screen_data;
                    if (screenData?.name === 'PaymentScreen') return true;
                }
            }
        } catch (_) {}

        // ២. ពិនិត្យ DOM Selectors ជាក់លាក់នៃផ្ទាំង Payment
        const paySelectors = [
            '.payment-screen',
            '.screen.payment',
            '.paymentlines',
            '.paymentline',
            '.payment-lines',
            '.paymentmethods',
            '.payment-methods',
            '.button.validate',
            '.button.validation',
            'button.validation',
            'button.validate'
        ];
        for (const sel of paySelectors) {
            if (document.querySelector(sel)) return true;
        }

        // ៣. ពិនិត្យវត្តមាន Validate Button + Payment Method (ABA KHQR, ACLEDA, Cash)
        const buttons = document.querySelectorAll('button, .button');
        let hasValidate = false;
        let hasPaymentKeyword = false;
        for (const btn of buttons) {
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (txt === 'validate' || txt.includes('validate')) hasValidate = true;
            if (txt.includes('khqr') || txt.includes('aba') || txt.includes('acleda') || txt.includes('cash')) {
                hasPaymentKeyword = true;
            }
        }
        if (hasValidate && hasPaymentKeyword) return true;

        // ៤. ពិនិត្យ Payment Button ដែលកំពុង Active / Highlight
        const activeButtons = document.querySelectorAll('.button.pay, button.pay, .btn-primary.pay');
        for (let btn of activeButtons) {
            if (btn.classList.contains('highlight') || btn.classList.contains('active')) {
                return true;
            }
        }

        return false;
    }

    /**
     * ត្រួតពិនិត្យថា Cashier ស្ថិតលើផ្ទាំង Receipt (ទូទាត់រួចរាល់) ឬអត់
     */
    function isReceiptScreenActive() {
        try {
            const pos = getOdooPos();
            if (pos) {
                if (pos.mainScreen?.name === 'ReceiptScreen') return true;
                const currentOrder = pos.get_order?.();
                const screenData = currentOrder?.get_screen_data?.() || currentOrder?.screen_data;
                if (screenData?.name === 'ReceiptScreen') return true;
            }
        } catch (_) {}

        return Boolean(document.querySelector('.receipt-screen, .pos-receipt-container'));
    }

    /**
     * ស្រង់តម្លៃសរុប (Total Amount)
     */
    function extractTotal(pos) {
        // ១. ស្រង់ពី Odoo POS Object
        if (pos) {
            const order = pos.get_order?.();
            if (order) {
                const total = order.get_total_with_tax?.() ?? order.get_total?.();
                if (typeof total === 'number' && total > 0) return total;
            }
        }

        // ២. ស្រង់ពី DOM (Header $ 2.18 ឬ Paymentlines)
        let maxTotal = 0;
        const candidates = document.querySelectorAll(
            '.payment-screen .total, .paymentlines-container, .pos-content header, .pos-topheader, .pay .amount, .total .value, .subentry .value'
        );
        for (const el of candidates) {
            const match = (el.innerText || '').match(/\$\s*([0-9]+\.[0-9]{2})/);
            if (match) {
                const val = parseFloat(match[1]);
                if (val > maxTotal) maxTotal = val;
            }
        }
        if (maxTotal > 0) return maxTotal;

        // ៣. ស្វែងរកទូទៅក្នុង DOM
        const all = document.querySelectorAll('div, span, button');
        for (const el of all) {
            if (el.closest('.products-widget') || el.closest('.product-list')) continue;
            const txt = (el.innerText || '').trim();
            const match = txt.match(/^\$\s*([0-9]+\.[0-9]{2})$/);
            if (match) {
                const val = parseFloat(match[1]);
                if (val > maxTotal) maxTotal = val;
            }
        }

        return maxTotal;
    }

    /**
     * ស្រង់ទំនិញក្នុងកន្ត្រក (Orderlines)
     */
    function extractItems(pos) {
        // ១. ស្រង់ពី Odoo POS Object
        if (pos) {
            const order = pos.get_order?.();
            if (order) {
                const lines = order.get_orderlines?.() || order.orderlines || [];
                if (Array.isArray(lines) && lines.length > 0) {
                    return lines.map(l => {
                        let name = '';
                        if (typeof l.get_full_product_name === 'function') name = l.get_full_product_name();
                        else if (l.product?.display_name) name = l.product.display_name;
                        else if (typeof l.get_product === 'function' && l.get_product()?.display_name) name = l.get_product().display_name;
                        else if (l.product_name) name = l.product_name;
                        else if (l.name) name = l.name;

                        let price = 0;
                        if (typeof l.get_unit_display_price === 'function') price = l.get_unit_display_price();
                        else if (typeof l.get_display_price === 'function') price = l.get_display_price();
                        else if (typeof l.get_unit_price === 'function') price = l.get_unit_price();
                        else if (l.price) price = l.price;

                        let qty = 1;
                        if (typeof l.get_quantity === 'function') qty = l.get_quantity();
                        else if (l.quantity !== undefined) qty = l.quantity;
                        else if (l.qty !== undefined) qty = l.qty;

                        let lineTotal = price * qty;
                        if (typeof l.get_display_price === 'function') lineTotal = l.get_display_price();
                        else if (typeof l.get_price_with_tax === 'function') lineTotal = l.get_price_with_tax();

                        return {
                            name: name || 'Item',
                            price: Number(price) || 0,
                            qty: Number(qty) || 1,
                            line_total: Number(lineTotal) || (Number(price) * Number(qty))
                        };
                    });
                }
            }
        }

        // ២. ស្រង់ពី DOM (ផ្ទាំង ProductScreen)
        const items = [];
        const lines = document.querySelectorAll('.orderline, .order-line, ul.orderlines li, div[role="listitem"]');
        lines.forEach(l => {
            if (l.closest('.products-widget') || l.closest('.product-list')) return;

            const nameEl  = l.querySelector('.product-name, .name, .product-title');
            const priceEl = l.querySelector('.price, .product-price');
            const qtyEl   = l.querySelector('.qty, .quantity');

            let name  = nameEl  ? nameEl.innerText.trim()  : '';
            let price = priceEl ? parseFloat(priceEl.innerText.replace(/[^0-9.]/g, '')) || 0 : 0;
            let qty   = qtyEl   ? parseFloat(qtyEl.innerText.replace(/[^0-9.]/g, ''))   || 1 : 1;

            if (!name) {
                const t = (l.innerText || '').trim();
                const parts = t.split('\n').map(s => s.trim()).filter(Boolean);
                for (let part of parts) {
                    if (!name && isNaN(Number(part)) && !part.startsWith('$')) {
                        name = part;
                    }
                }
                const priceM = t.match(/\$\s*([0-9.]+)/);
                if (priceM && !price) price = parseFloat(priceM[1]);
            }

            if (name) {
                items.push({ name, price, qty, line_total: price * qty });
            }
        });

        return items;
    }

    /**
     * ត្រួតពិនិត្យ និង Sync ទិន្នន័យពី Odoo POS ទៅ Vercel
     */
    function checkPOS() {
        const STORE_ID  = getStoreId();
        const RESET_API = `${VERCEL_BASE}/api/reset?store=${STORE_ID}`;

        // ១. បើស្ថិតលើផ្ទាំង Receipt (ការទូទាត់បានចប់សព្វគ្រប់)
        const isReceipt = isReceiptScreenActive();
        if (isReceipt) {
            cachedItems = [];
            cachedTotal = 0;
            cachedRef   = '';
            return;
        }

        const isPayment = isPaymentScreenActive();
        const pos       = getOdooPos();

        let total = extractTotal(pos);
        let items = extractItems(pos);

        // ២. រក្សាទុកក្នុង Cache ឬ ស្រង់ចេញពី Cache ពេលស្ថិតលើផ្ទាំង Payment
        if (items.length > 0) {
            cachedItems = items;
        } else if (isPayment && cachedItems.length > 0) {
            // លើផ្ទាំង Payment, Odoo ដោះ DOM .orderline ចេញ -> យកពី Cache មកវិញ!
            items = cachedItems;
        }

        if (total > 0) {
            cachedTotal = total;
        } else if (isPayment && cachedTotal > 0) {
            total = cachedTotal;
        }

        // ៣. Auto Reset តែពេលនៅផ្ទាំងកន្ត្រកទំនិញ (Product Screen) ហើយកន្ត្រកពិតជាទទេ (total === 0)
        if (!isPayment && (total === 0 || items.length === 0)) {
            cachedItems = [];
            cachedTotal = 0;
            cachedRef   = '';
            if (!isCurrentlyReset && lastKey !== '') {
                isCurrentlyReset = true;
                lastKey = '';
                GM_xmlhttpRequest({ method: 'GET', url: RESET_API });
            }
            return;
        }

        // ៤. ផ្ទាំង Payment ត្រូវបានបើក -> បង្ហាញ Popup KHQR (show_qr: true)
        const showQR = isPayment;

        // ៥. កំណត់ Order Reference ឱ្យថេរក្នុងមួយ Order
        let orderRef = '';
        if (pos) {
            const order = pos.get_order?.();
            if (order) orderRef = order.get_name?.() || order.name || '';
        }
        if (!orderRef) {
            if (!cachedRef || (!isPayment && items.length === 0)) {
                cachedRef = 'POS-' + Math.floor(1000 + Math.random() * 9000);
            }
            orderRef = cachedRef;
        } else {
            cachedRef = orderRef;
        }

        // ៦. ផ្ទៀងផ្ទាត់ Key បើមានការផ្លាស់ប្តូរ ទើបបាញ់ Sync ទៅ Vercel
        const itemsKey = items.map(i => `${i.name}_${i.qty}_${i.price}`).join('|');
        const key = `${STORE_ID}_${total}_${showQR}_${itemsKey}_${orderRef}`;

        if (total > 0 && key !== lastKey) {
            lastKey = key;
            isCurrentlyReset = false;

            const payload = {
                store_id: STORE_ID,
                name: orderRef,
                reference: orderRef,
                amount_total: total,
                currency: 'USD',
                items: items,
                show_qr: showQR, // true ភ្លាមៗពេល Cashier ចុច Payment!
                status: 'ACTIVE'
            };

            GM_xmlhttpRequest({
                method: 'POST',
                url: VERCEL_API,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                onload: function(res) {
                    console.log(`⚡ [Odoo POS -> Vercel] Store: ${STORE_ID} | ShowQR: ${showQR} | Total: $${total} | Items: ${items.length}`);
                },
                onerror: function(err) {
                    console.error(`❌ [Odoo POS -> Vercel] Sync failed:`, err);
                }
            });
        }
    }

    // ពិនិត្យរៀងរាល់ 200ms
    setInterval(checkPOS, 200);

    // ចាប់យក Event Click ដើម្បី Sync ភ្លាមៗ (ចុច Payment, Validate, etc.)
    document.addEventListener('click', function(e) {
        setTimeout(checkPOS, 20);
        setTimeout(checkPOS, 120);
    });

})();

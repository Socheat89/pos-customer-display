// ==UserScript==
// @name         Odoo POS Dynamic Store Extractor & Popup KHQR Sync
// @namespace    http://tampermonkey.net/
// @version      14.9
// @description  Auto-detect POS Session/Store ID and Sync to Vercel with Popup KHQR on Payment
// @author       Doem Socheat
// @match        *://skco-test-saas19-0917.odoo.com/*
// @match        *://*.odoo.com/pos/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      pos-customer-display.vercel.app
// @connect      *
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
    let lastScreenState  = '';
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
     * Odoo 17/18 OWL — check ProductScreen first, then payment indicators only
     */
    function isPaymentScreenActive() {
        // !! PRIORITY 0: បើក័សែ ProductScreen DOM ស្ក័នវិលត្កែន មានន័យថានៅលើ Payment Screen
        //    ត្រួតពិនិត្យចុចនេះមុនពេលែរបស់ ប្រាកត្តបញ័ះយរត្នត័សែកៅលើថា២
        const prodScreen = document.querySelector(
            '.product-screen, [class*="product-screen"], .products-widget'
        );
        if (prodScreen && prodScreen.offsetParent !== null) return false;

        // 1. Odoo POS JS Model (most accurate)
        try {
            const pos = getOdooPos();
            if (pos) {
                const screen = pos.mainScreen?.component?.name || pos.mainScreen?.name;
                if (screen === 'PaymentScreen') return true;
                if (screen === 'ProductScreen') return false;

                const currentOrder = pos.get_order?.();
                if (currentOrder) {
                    const screenData = currentOrder.get_screen_data?.() || currentOrder.screen_data;
                    if (screenData?.name === 'PaymentScreen') return true;
                    if (screenData?.name === 'ProductScreen') return false;
                }
            }
        } catch (_) {}

        // 2. Odoo 17 OWL — payment screen container selectors
        const owlPaySelectors = [
            '.payment-screen',
            '.screen.payment',
            '[class*="payment-screen"]',
            '[class*="PaymentScreen"]',
            '.pos-payment',
            '.payment-method-list',
            '.payment-methods-list',
        ];
        for (const sel of owlPaySelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return true;
        }

        // 3. Payment lines (paymentlines container visible)
        const payLines = document.querySelector(
            '.paymentlines, .payment-lines, .paymentlines-container, .paymentmethods'
        );
        if (payLines && payLines.offsetParent !== null) return true;

        // 4. Validate button visible (ONLY appears on Payment Screen, not Product Screen)
        const validateBtn = document.querySelector(
            'button.validate, .button.validate, button.validation'
        );
        if (validateBtn && validateBtn.offsetParent !== null) return true;

        // 5. ABA KHQR or payment method buttons visible
        //    NOTE: only scan for method names, NOT 'payment' or 'payment' button on product screen
        const allButtons = document.querySelectorAll('button, .button, [role="button"]');
        for (const btn of allButtons) {
            if (btn.offsetParent === null) continue;
            const txt = (btn.innerText || btn.textContent || '').toLowerCase().trim();
            // Only match payment METHOD names (unique to payment screen)
            if (txt === 'aba khqr' || txt.includes('khqr') ||
                txt === 'cash' || txt === 'bank transfer') {
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
            try {
                const order = pos.get_order?.();
                if (order) {
                    const total = order.get_total_with_tax?.() ?? order.get_total?.();
                    if (typeof total === 'number' && total > 0) return total;
                }
            } catch (_) {}
        }

        // ២. ស្វែងរក Total Element ក្នុង Odoo POS (Product Screen & Payment Screen)
        const totalSelectors = [
            '.order-summary .total',
            '.order-summary .amount',
            '.order-summary .value',
            '.order-summary',
            '.pads .subentry .value',
            '.payment-screen .total',
            '.paymentlines-container',
            '.pay .amount'
        ];
        for (const sel of totalSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const m = (el.innerText || '').match(/\$\s*([0-9]+\.[0-9]{2})/);
                if (m) {
                    const val = parseFloat(m[1]);
                    if (val > 0) return val;
                }
            }
        }

        // ៣. ស្វែងរកទូទៅដែលមានពាក្យ "Total" ឬ "$" ក្នុង DOM
        let maxTotal = 0;
        const all = document.querySelectorAll('div, span, button');
        for (const el of all) {
            if (el.closest('.products-widget') || el.closest('.product-list')) continue;
            const txt = (el.innerText || '').trim();
            const match = txt.match(/\$\s*([0-9]+\.[0-9]{2})/);
            if (match) {
                const val = parseFloat(match[1]);
                if (val > maxTotal) maxTotal = val;
            }
        }

        return maxTotal;
    }

    const imageCache = {};

    function fetchImageAsBase64(url, callback) {
        if (!url || typeof GM_xmlhttpRequest === 'undefined') return;
        if (url.startsWith('data:')) {
            if (callback) callback(url);
            return;
        }
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            onload: function(res) {
                if (res.response) {
                    const reader = new FileReader();
                    reader.onloadend = function() {
                        if (reader.result && callback) {
                            callback(reader.result);
                        }
                    };
                    reader.readAsDataURL(res.response);
                }
            }
        });
    }

    function getBase64FromImg(img) {
        if (!img) return null;
        if (img.src && img.src.startsWith('data:')) return img.src;
        if (!img.complete || img.naturalWidth === 0) return null;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(img.naturalWidth, 128);
            canvas.height = Math.min(img.naturalHeight, 128);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.85);
        } catch (_) {
            return null;
        }
    }

    function cleanProductName(name, qty) {
        if (!name) return '';
        let s = String(name).trim();
        // Remove leading quantity followed by whitespace or newline
        s = s.replace(/^\d+[\s\r\n]+/, '').trim();
        // Remove attached quantity prefix, e.g. "1002-..." when qty=1 -> "002-..."
        if (qty && s.startsWith(String(qty)) && /^\d{4,}/.test(s)) {
            const stripped = s.slice(String(qty).length);
            if (/^\d{3}-/.test(stripped) || /^[A-Za-z]/.test(stripped)) {
                s = stripped;
            }
        }
        if (s.startsWith('1') && /^1[A-Z]\s+/.test(s)) {
            s = s.slice(1).trim();
        }
        return s;
    }

    function findProductImage(productId, productName, qty) {
        const cleanName = cleanProductName(productName, qty);
        const lowerName = cleanName.toLowerCase();
        const cacheKey  = `${productId || ''}__${lowerName}`;
        if (imageCache[cacheKey]) return imageCache[cacheKey];

        if (productId && imageCache[`id:${productId}`]) {
            return imageCache[`id:${productId}`];
        }
        if (lowerName && imageCache[`name:${lowerName}`]) {
            return imageCache[`name:${lowerName}`];
        }

        // 1. Try from Odoo POS DB
        try {
            const pos = getOdooPos();
            if (pos) {
                const prod = (pos.db?.get_product_by_id?.(productId)) ||
                             (pos.db?.product_by_id?.[productId]) ||
                             (pos.models?.['product.product']?.get?.(productId));
                if (prod?.image_128 && prod.image_128.length > 30) {
                    const src = prod.image_128.startsWith('data:') ? prod.image_128 : `data:image/png;base64,${prod.image_128}`;
                    imageCache[cacheKey] = src;
                    return src;
                }
            }
        } catch (_) {}

        // 2. Scan Catalog Cards in DOM
        const cards = document.querySelectorAll('.product, .product-card, article.product, [data-product-id]');
        for (const c of cards) {
            const cardId = c.dataset?.productId || c.getAttribute('data-product-id') || c.__owl__?.component?.props?.product?.id;
            const nameEl = c.querySelector('.product-name, .name, .product-title, .product-content');
            const cardName = (nameEl ? nameEl.innerText : c.innerText || '').trim().toLowerCase();

            const matchId = productId && String(cardId) === String(productId);
            const matchName = lowerName && cardName && (cardName === lowerName || cardName.includes(lowerName) || lowerName.includes(cardName));

            if (matchId || matchName) {
                const img = c.querySelector('img');
                let imgUrl = img?.src;
                if (!imgUrl) {
                    const bgEl = c.querySelector('.product-img, [style*="background-image"]');
                    const m = (bgEl?.style?.backgroundImage || '').match(/url\(['"]?(.*?)['"]?\)/);
                    if (m) imgUrl = m[1];
                }

                if (imgUrl && !imgUrl.includes('placeholder')) {
                    const b64 = img ? getBase64FromImg(img) : null;
                    if (b64) {
                        imageCache[cacheKey] = b64;
                        if (productId) imageCache[`id:${productId}`] = b64;
                        if (lowerName) imageCache[`name:${lowerName}`] = b64;
                        return b64;
                    }
                    // Fetch as Base64 in background
                    fetchImageAsBase64(imgUrl, (resB64) => {
                        if (resB64) {
                            imageCache[cacheKey] = resB64;
                            if (productId) imageCache[`id:${productId}`] = resB64;
                            if (lowerName) imageCache[`name:${lowerName}`] = resB64;
                        }
                    });
                    imageCache[cacheKey] = imgUrl;
                    return imgUrl;
                }
            }
        }

        // 3. Fallback: Request direct Odoo web/image as Base64 by productId
        if (productId) {
            const url = `${window.location.origin}/web/image?model=product.product&id=${productId}&field=image_128`;
            fetchImageAsBase64(url, (resB64) => {
                if (resB64) {
                    imageCache[cacheKey] = resB64;
                    imageCache[`id:${productId}`] = resB64;
                }
            });
            imageCache[cacheKey] = url;
            return url;
        }

        return null;
    }

    /**
     * ស្រង់ទំនិញក្នុងកន្ត្រក (Orderlines)
     */
    function extractItems(pos) {
        // ១. ស្រង់ពី Odoo POS Object
        if (pos) {
            const order = pos.get_order?.();
            if (order) {
                const rawLines = order.get_orderlines?.() || order.orderlines || order.lines || (typeof order.get_lines === 'function' ? order.get_lines() : []);
                const lines = Array.isArray(rawLines) ? rawLines : Array.from(rawLines || []);
                if (lines.length > 0) {
                    return lines.map(l => {
                        let name = '';
                        if (typeof l.get_full_product_name === 'function') name = l.get_full_product_name();
                        else if (l.product?.display_name) name = l.product.display_name;
                        else if (typeof l.get_product === 'function' && l.get_product()?.display_name) name = l.get_product().display_name;
                        else if (l.product_name) name = l.product_name;
                        else if (l.product?.name) name = l.product.name;
                        else if (l.name) name = l.name;

                        let price = 0;
                        if (typeof l.get_unit_display_price === 'function') price = l.get_unit_display_price();
                        else if (typeof l.get_display_price === 'function') price = l.get_display_price();
                        else if (typeof l.get_unit_price === 'function') price = l.get_unit_price();
                        else if (l.price !== undefined) price = l.price;

                        let qty = 1;
                        if (typeof l.get_quantity === 'function') qty = l.get_quantity();
                        else if (l.quantity !== undefined) qty = l.quantity;
                        else if (l.qty !== undefined) qty = l.qty;

                        let lineTotal = price * qty;
                        if (typeof l.get_display_price === 'function') lineTotal = l.get_display_price();
                        else if (typeof l.get_price_with_tax === 'function') lineTotal = l.get_price_with_tax();

                        let prod = l.product || (typeof l.get_product === 'function' ? l.get_product() : null);
                        let prodId = prod?.id || l.product_id;
                        if (Array.isArray(prodId)) prodId = prodId[0];

                        name = cleanProductName(name, qty);
                        const img = findProductImage(prodId, name, qty);

                        return {
                            name: name || 'Item',
                            price: Number(price) || 0,
                            qty: Number(qty) || 1,
                            line_total: Number(lineTotal) || (Number(price) * Number(qty)),
                            image: img || null
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

            let name = '';
            let price = 0;
            let qty = 1;
            let prodId = null;

            // Try OWL component on line
            try {
                const comp = l.__owl__?.component;
                const line = comp?.props?.line || comp?.line;
                if (line) {
                    const prod = line.product || (typeof line.get_product === 'function' ? line.get_product() : null);
                    if (prod) {
                        prodId = prod.id;
                        name = line.get_full_product_name?.() || prod.display_name || prod.name || '';
                    }
                    if (typeof line.get_unit_display_price === 'function') price = line.get_unit_display_price();
                    else if (typeof line.get_display_price === 'function') price = line.get_display_price();
                    else if (line.price !== undefined) price = line.price;

                    if (typeof line.get_quantity === 'function') qty = line.get_quantity();
                    else if (line.quantity !== undefined) qty = line.quantity;
                    else if (line.qty !== undefined) qty = line.qty;
                }
            } catch (_) {}

            if (!name) {
                const nameEl  = l.querySelector('.product-name, .name, .product-title');
                const priceEl = l.querySelector('.price, .product-price');
                const qtyEl   = l.querySelector('.qty, .quantity');

                if (nameEl) name = nameEl.innerText.trim();
                if (priceEl && !price) price = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, '')) || 0;
                if (qtyEl && qty === 1) qty = parseFloat(qtyEl.innerText.replace(/[^0-9.]/g, '')) || 1;

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
            }

            if (name) {
                name = cleanProductName(name, qty);
                const img = findProductImage(prodId, name, qty);
                items.push({
                    name,
                    price: Number(price) || 0,
                    qty: Number(qty) || 1,
                    line_total: (Number(price) || 0) * (Number(qty) || 1),
                    image: img || null
                });
            }
        });

        return items;
    }

    /**
     * ត្រួតពិនិត្យ និង Sync ទិន្នន័យពី Odoo POS ទៅ Vercel
     */
    function checkPOS() {
        try {
            const STORE_ID  = getStoreId();
            const RESET_API = `${VERCEL_BASE}/api/reset?store=${STORE_ID}`;

            const pos = getOdooPos();

            // ──────────────────────────────────────────────────────────
            // A. ស្រង់ Screen Name ពី Odoo JS model (ត្រឹមត្រូវបំផុត)
            // ──────────────────────────────────────────────────────────
            let screenName = '';
            try {
                if (pos) {
                    // Odoo 17/18 OWL: mainScreen is a reactive object
                    if (pos.mainScreen?.component?.name) {
                        screenName = pos.mainScreen.component.name;
                    } else if (typeof pos.mainScreen?.name === 'string') {
                        screenName = pos.mainScreen.name;
                    }
                    // Fallback: screen_data on current order
                    if (!screenName) {
                        const ord = pos.get_order?.();
                        const sd  = ord?.get_screen_data?.() ?? ord?.screen_data;
                        if (sd?.name) screenName = sd.name;
                    }
                }
            } catch (_) {}

            // ──────────────────────────────────────────────────────────
            // B. DOM fallback flags (ប្រើបន្ថែម មិនលើកឡើង)
            // ──────────────────────────────────────────────────────────
            const domHasReceipt  = Boolean(document.querySelector('.receipt-screen, .pos-receipt-container'));
            const domHasPayment  = Boolean(document.querySelector(
                '.payment-screen, .paymentlines, .paymentmethods, .payment-methods'
            ));
            // Validate button exists AND a payment method button exists (narrow check)
            const hasValidateBtn = Boolean(document.querySelector(
                'button.validate, .button.validate, button.validation'
            ));
            const hasPaymentMethodBtn = Boolean(document.querySelector(
                '.paymentmethod, .payment-method, [data-method], .paymentmethods .button'
            ));
            const domPaymentStrict = domHasPayment || (hasValidateBtn && hasPaymentMethodBtn);

            // ──────────────────────────────────────────────────────────
            // C. ចាត់ប្រភេទ Screen (ផ្សំ JS Model + DOM Selectors)
            // ──────────────────────────────────────────────────────────
            const isPayment = screenName === 'PaymentScreen' || isPaymentScreenActive();
            const isReceipt = (screenName === 'ReceiptScreen' || (!isPayment && isReceiptScreenActive())) && !isPayment;
            const effectiveScreen = screenName || (isPayment ? 'PaymentScreen' : (isReceipt ? 'ReceiptScreen' : 'ProductScreen'));
            const stateKey = `${effectiveScreen}|${isPayment}|${isReceipt}`;
            if (stateKey !== lastScreenState) {
                lastScreenState = stateKey;
                console.log(`[POS Sync] store=${STORE_ID} screen="${effectiveScreen}" isPayment=${isPayment} isReceipt=${isReceipt}`);
            }

        // ──────────────────────────────────────────────────────────
        // D. ស្រង់ Currency ពី Odoo POS
        // ──────────────────────────────────────────────────────────
        let currency = 'USD';
        try {
            if (pos) {
                currency = pos.currency?.name || pos.company_currency?.name || (pos.currency_id === 143 ? 'KHR' : 'USD');
            }
        } catch (_) {}

        // ──────────────────────────────────────────────────────────
        // ស្រង់ Order Reference / Tab ID (ឧ. 68002, 68003, POS-xxx)
        // ──────────────────────────────────────────────────────────
        function extractOrderRef(posObj) {
            if (posObj) {
                try {
                    const ord = posObj.get_order?.() || posObj.selectedOrder;
                    if (ord) {
                        const ref = ord.get_name?.() || ord.name || ord.tracking_number || ord.sequence_number || ord.pos_reference;
                        if (ref) return String(ref).trim();
                    }
                } catch (_) {}
            }
            // ស្រង់ពី DOM Tab Bar ខាងលើ (ឧ. Tab "68003", "68002")
            const activeTab = document.querySelector(
                '.order-button.selected, .select-order.selected, .order-selector .selected, .ticket-button.active, .ticket-button.highlight, .pos-rightheader .order-button'
            );
            if (activeTab) {
                const txt = (activeTab.innerText || activeTab.textContent || '').trim();
                if (txt && !txt.includes('+') && !txt.toLowerCase().includes('order')) {
                    return txt;
                }
            }
            return '';
        }

        // ──────────────────────────────────────────────────────────
        // បាញ់ SUCCESS ទៅ Vercel ពេល Payment រួចរាល់
        // ──────────────────────────────────────────────────────────
        function sendPaymentSuccess(ref, totalVal, itemsList, curr) {
            if (lastKey === 'SUCCESS_SENT') return;
            lastKey = 'SUCCESS_SENT';
            console.log(`🎉 [POS Sync] Payment SUCCESS for ${ref || 'ORDER'} ($${totalVal}) → syncing to Customer Display`);

            GM_xmlhttpRequest({
                method: 'POST',
                url: VERCEL_API,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    store_id:     STORE_ID,
                    name:         ref || 'POS-ORDER',
                    reference:    ref || 'POS-ORDER',
                    amount_total: Number(totalVal) || 0,
                    currency:     curr || 'USD',
                    items:        Array.isArray(itemsList) ? itemsList : [],
                    show_qr:      false,
                    status:       'SUCCESS'
                }),
                onload: function(res) {
                    console.log('✅ [POS Sync] SUCCESS sent successfully (HTTP ' + res.status + ')');
                },
                onerror: function(err) {
                    console.error('❌ [POS Sync] Failed to send SUCCESS:', err);
                }
            });

            // សម្អាត Cache ចោលទាំងអស់ដើម្បីកុំឱ្យ Order ចាស់មកវិញ
            cachedItems = [];
            cachedTotal = 0;
            cachedRef   = '';
        }

        // ──────────────────────────────────────────────────────────
        // E. ពិនិត្យថា Order ត្រូវបាន Validate ឬ Paid រួចរាល់
        // ──────────────────────────────────────────────────────────
        const currentOrder = pos?.get_order?.();
        const isOrderFinalized = Boolean(
            isReceipt ||
            (currentOrder && (
                currentOrder.finalized === true ||
                currentOrder.state === 'paid' ||
                currentOrder.state === 'done' ||
                (typeof currentOrder.is_paid === 'function' && currentOrder.is_paid())
            ))
        );

        if (isOrderFinalized) {
            if (lastKey !== 'SUCCESS_SENT') {
                const finalRef   = extractOrderRef(pos) || cachedRef || 'POS-ORDER';
                const finalTotal = cachedTotal || extractTotal(pos);
                const finalItems = cachedItems.length ? cachedItems : extractItems(pos);
                sendPaymentSuccess(finalRef, finalTotal, finalItems, currency);
            }
            return;
        }

        // ──────────────────────────────────────────────────────────
        // F. ស្រង់ Items, Total & Order Ref
        // ──────────────────────────────────────────────────────────
        let total = extractTotal(pos);
        let items = extractItems(pos);
        const currentRef = extractOrderRef(pos);

        // ប្រសិនបើដូរ Order Tab (ឧ. ពី 68002 ទៅ 68003) -> សម្អាត Cache ចាស់ចោលភ្លាម
        if (currentRef && cachedRef && currentRef !== cachedRef) {
            console.log(`[POS Sync] New order detected: ${currentRef} (was ${cachedRef}) -> clearing cache`);
            cachedItems = [];
            cachedTotal = 0;
            cachedRef   = currentRef;
            lastKey     = '';
        }
        if (currentRef) cachedRef = currentRef;

        // ──────────────────────────────────────────────────────────
        // G. Cart Empty handling (ផ្ទាំង Register / ProductScreen)
        // ──────────────────────────────────────────────────────────
        if (!isPayment && items.length === 0) {
            // Cart ទទេលើ ProductScreen (ឧ. Order ថ្មី 68003 ឬ Cancelled)
            cachedItems = [];
            cachedTotal = 0;
            total       = 0;

            if (lastKey !== 'RESET_IDLE') {
                lastKey = 'RESET_IDLE';
                console.log('[POS Sync] ProductScreen cart is empty → calling RESET to IDLE');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: RESET_API,
                    onload: function() {
                        console.log('✅ [POS Sync] Display reset to Welcome screen (IDLE)');
                    }
                });
            }
            return;
        }

        // ប្រសិនបើនៅលើ PaymentScreen តែ Odoo លាក់ lines ក្នុង DOM -> ប្រើ Cache
        if (isPayment && items.length === 0) {
            if (cachedItems.length > 0) {
                items = cachedItems;
                if (total === 0) total = cachedTotal;
            } else {
                return;
            }
        }

        if (items.length > 0) {
            cachedItems = items;
        }

        const itemsSum = items.reduce((sum, i) => sum + (Number(i.line_total) || (Number(i.price) * Number(i.qty))), 0);
        if (itemsSum > 0 && (total === 0 || Math.abs(total - itemsSum) > 0.01)) {
            total = Math.round(itemsSum * 100) / 100;
        }
        if (total > 0) cachedTotal = total;

        // បើគ្មានទំនិញទាំងស្រុង ត្រូវ Reset ត្រឡប់ទៅ IDLE ភ្លាម
        if (items.length === 0 || total === 0) {
            cachedItems = [];
            cachedTotal = 0;
            if (lastKey !== 'RESET_IDLE') {
                lastKey = 'RESET_IDLE';
                console.log('[POS Sync] No items or total 0 → calling RESET');
                GM_xmlhttpRequest({ method: 'GET', url: RESET_API });
            }
            return;
        }

        // ──────────────────────────────────────────────────────────
        // H. Sync ទៅ Vercel តែប្រសិនបើ Key ផ្លាស់ប្ដូរ
        // ──────────────────────────────────────────────────────────
        const showQR   = isPayment;
        const itemsKey = items.map(i => `${i.name}_${i.qty}_${i.price}_${i.image ? '1' : '0'}`).join('|');
        const orderRef = currentRef || cachedRef || 'POS-' + Math.floor(1000 + Math.random() * 9000);
        const key      = `${STORE_ID}|${total}|${showQR}|${itemsKey}|${orderRef}|${currency}`;

        if (total > 0 && key !== lastKey) {
            lastKey = key;

            const payload = {
                store_id:     STORE_ID,
                name:         orderRef,
                reference:    orderRef,
                amount_total: total,
                currency:     currency,
                items:        items,
                show_qr:      showQR,
                status:       'ACTIVE'
            };

            console.log(`⚡ [POS→Vercel] store=${STORE_ID} showQR=${showQR} total=$${total} items=${items.length} curr=${currency} ref=${orderRef}`);
            GM_xmlhttpRequest({
                method: 'POST',
                url: VERCEL_API,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                onload: function(res) {
                    if (res.status >= 400) {
                        console.error('❌ [POS→Vercel] HTTP ' + res.status + ':', res.responseText);
                        lastKey = ''; // Reset so it retries automatically on next interval
                    } else {
                        console.log('✅ [POS→Vercel] Synced successfully to Vercel (HTTP ' + res.status + ')');
                    }
                },
                onerror: function(err) {
                    console.error('❌ [POS→Vercel] Sync failed:', err);
                    lastKey = ''; // Reset so it retries automatically on next interval
                }
            });
        }
    } catch (err) {
        console.error('[POS Sync Error]', err);
    }
}

    // ពិនិត្យរៀងរាល់ 250ms
    setInterval(checkPOS, 250);

    // ចាប់ Event Click ដើម្បី Sync ភ្លាមៗ (ចុច Payment, Validate, etc.)
    document.addEventListener('click', function(e) {
        const target = e.target;
        const btn = target?.closest?.('button.validate, .button.validate, button.validation, .payment-screen button.next, button.highlight, .pay-circle, [class*="validate"]');
        const txt = (target?.innerText || target?.textContent || '').trim().toLowerCase();

        // ប្រសិនបើចុចលើប៊ូតុង Validate ត្រូវកត់ត្រាថា Payment រួចរាល់ភ្លាម
        if (btn || txt === 'validate' || txt.includes('validate')) {
            console.log('🖱️ [POS Sync] Validate button clicked → syncing SUCCESS');
            try {
                const pos = getOdooPos();
                const ord = pos?.get_order?.();
                const ref = ord?.get_name?.() || ord?.name || cachedRef || 'POS-ORDER';
                const tot = cachedTotal || extractTotal(pos);
                const its = cachedItems.length ? cachedItems : extractItems(pos);
                const cur = pos?.currency?.name || pos?.company_currency?.name || 'USD';
                sendPaymentSuccess(ref, tot, its, cur);
            } catch (_) {}
        }

        setTimeout(checkPOS, 30);
        setTimeout(checkPOS, 200);
        setTimeout(checkPOS, 500);
    });

})();

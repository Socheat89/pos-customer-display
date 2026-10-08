// ==UserScript==
// @name         Odoo POS Dynamic Store Extractor & Popup KHQR Sync
// @namespace    http://tampermonkey.net/
// @version      14.14
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
    let lastKey         = '';
    let lastScreenState = '';
    let cachedItems     = [];
    let cachedTotal     = 0;
    let cachedRef       = '';

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
        // បើផ្ទាំង ProductScreen ឬ PaymentScreen កំពុងបង្ហាញ មានន័យថាមិនមែន ReceiptScreen ទេ!
        const prodScreen = document.querySelector(
            '.product-screen, [class*="product-screen"], .products-widget'
        );
        if (prodScreen && prodScreen.offsetParent !== null) return false;

        const payScreen = document.querySelector(
            '.payment-screen, [class*="payment-screen"], [class*="PaymentScreen"]'
        );
        if (payScreen && payScreen.offsetParent !== null) return false;

        try {
            const pos = getOdooPos();
            if (pos) {
                const screen = pos.mainScreen?.component?.name || pos.mainScreen?.name;
                if (screen === 'ReceiptScreen') return true;
                if (screen === 'ProductScreen' || screen === 'PaymentScreen') return false;

                const currentOrder = pos.get_order?.() || pos.selectedOrder;
                if (currentOrder) {
                    const screenData = currentOrder.get_screen_data?.() || currentOrder.screen_data;
                    if (screenData?.name === 'ReceiptScreen') return true;
                    if (screenData?.name === 'ProductScreen' || screenData?.name === 'PaymentScreen') return false;
                }
            }
        } catch (_) {}

        return Boolean(document.querySelector(
            '.receipt-screen, [class*="ReceiptScreen"], .pos-receipt-container, .pos-receipt, .receipt-content'
        ));
    }

    /**
     * ស្រង់តម្លៃសរុប (Total Amount)
     */
    function extractTotal(pos) {
        // ១. ស្រង់ពី Odoo POS Object
        if (pos) {
            try {
                const order = pos.get_order?.() || pos.selectedOrder;
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
            '.paymentlines-container .total'
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

        return 0;
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

        // 1. Try from Odoo POS DB & Odoo 18 Models
        try {
            const pos = getOdooPos();
            if (pos) {
                // By numeric or string productId
                if (productId && (typeof productId === 'number' || typeof productId === 'string')) {
                    const prod = (pos.db?.get_product_by_id?.(productId)) ||
                                 (pos.db?.product_by_id?.[productId]) ||
                                 (pos.models?.['product.product']?.get?.(productId));
                    const imgData = prod?.image_128 || prod?.image_256 || prod?.image_512;
                    if (imgData && imgData.length > 30) {
                        const src = imgData.startsWith('data:') ? imgData : `data:image/png;base64,${imgData}`;
                        imageCache[cacheKey] = src;
                        imageCache[`id:${productId}`] = src;
                        return src;
                    }
                }

                // By productName search in pos.models or pos.db
                if (lowerName && lowerName !== 'item') {
                    const allProds = pos.models?.['product.product']?.getAll?.() ||
                                     pos.models?.['product.product']?.records ||
                                     (pos.db?.product_by_id ? Object.values(pos.db.product_by_id) : []);
                    for (const p of allProds) {
                        const pName = (p.display_name || p.name || '').toLowerCase();
                        if (pName && (pName === lowerName || pName.includes(lowerName) || lowerName.includes(pName))) {
                            const imgData = p.image_128 || p.image_256 || p.image_512;
                            if (imgData && imgData.length > 30) {
                                const src = imgData.startsWith('data:') ? imgData : `data:image/png;base64,${imgData}`;
                                imageCache[cacheKey] = src;
                                if (p.id) imageCache[`id:${p.id}`] = src;
                                imageCache[`name:${lowerName}`] = src;
                                return src;
                            }
                            if (p.id && !productId) {
                                productId = p.id;
                                break;
                            }
                        }
                    }
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
            const matchName = lowerName && lowerName !== 'item' && cardName && (cardName === lowerName || cardName.includes(lowerName) || lowerName.includes(cardName));

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

        // 3. Fallback: Request direct Odoo web/image as Base64 by numeric productId
        const numId = Number(productId);
        if (numId && !isNaN(numId) && numId > 0) {
            const url = `${window.location.origin}/web/image?model=product.product&id=${numId}&field=image_128`;
            fetchImageAsBase64(url, (resB64) => {
                if (resB64) {
                    imageCache[cacheKey] = resB64;
                    imageCache[`id:${numId}`] = resB64;
                }
            });
            imageCache[cacheKey] = url;
            return url;
        }

        return null;
    }

    /**
     * ស្រង់ទិន្នន័យពី Orderline នីមួយៗ (គាំទ្រទាំង Odoo 16/17/18 និង DOM fallback)
     */
    function extractLineDetails(l, el, pos, idx) {
        // ១. ស្វែងរក Product Record និង Product ID
        let prod = null;
        if (typeof l?.get_product === 'function') {
            try { prod = l.get_product(); } catch (_) {}
        }
        if (!prod && typeof l?.product === 'object' && l?.product !== null) {
            prod = l.product;
        }
        if (!prod && typeof l?.product_id === 'object' && l?.product_id !== null) {
            prod = l.product_id;
        }

        let prodId = null;
        if (prod && typeof prod.id === 'number') {
            prodId = prod.id;
        } else if (typeof l?.product_id === 'number') {
            prodId = l.product_id;
        } else if (typeof l?.product === 'number') {
            prodId = l.product;
        } else if (Array.isArray(l?.product_id)) {
            prodId = l.product_id[0];
        } else if (Array.isArray(l?.product)) {
            prodId = l.product[0];
        } else if (el) {
            const dId = el.dataset?.productId || el.getAttribute?.('data-product-id');
            if (dId && !isNaN(Number(dId))) prodId = Number(dId);
        }

        // ប្រសិនបើស្គាល់ prodId អាចទាញ Product Record ពី pos model / db បន្ថែម
        if (prodId && pos) {
            try {
                const dbProd = (pos.db?.get_product_by_id?.(prodId)) ||
                               (pos.db?.product_by_id?.[prodId]) ||
                               (pos.models?.['product.product']?.get?.(prodId));
                if (dbProd) {
                    if (!prod) prod = dbProd;
                    else prod = Object.assign({}, dbProd, prod);
                }
            } catch (_) {}
        }

        // ២. ស្រង់ឈ្មោះទំនិញ (Product Name)
        let name = '';
        if (typeof l?.get_full_product_name === 'function') {
            try { name = l.get_full_product_name(); } catch (_) {}
        }
        if (!name && typeof l?.full_product_name === 'string') name = l.full_product_name;
        if (!name && typeof l?.get_product_name === 'function') {
            try { name = l.get_product_name(); } catch (_) {}
        }
        if (!name && l?.product_name) name = l.product_name;
        if (!name && prod?.display_name) name = prod.display_name;
        if (!name && prod?.name) name = prod.name;
        if (!name && l?.product_id?.display_name) name = l.product_id.display_name;
        if (!name && l?.product_id?.name) name = l.product_id.name;
        if (!name && l?.display_name) name = l.display_name;
        if (!name && l?.name && l.name !== '/' && l.name !== '-' && !l.name.toLowerCase().startsWith('order')) {
            name = l.name;
        }

        // DOM Fallback សម្រាប់ Product Name
        if ((!name || name.toLowerCase() === 'item') && el) {
            const nameEl = el.querySelector?.('.product-name, .name, .product-title, .product-content, [class*="product_name"]');
            if (nameEl) {
                name = (nameEl.innerText || nameEl.textContent || '').trim();
            } else {
                const textNodes = Array.from(el.querySelectorAll('span, div')).filter(
                    node => !node.innerText.includes('$') && node.children.length === 0 && node.innerText.trim().length > 1
                );
                if (textNodes.length > 0) {
                    name = textNodes[0].innerText.trim();
                }
            }
        }

        // ៣. ស្រង់ចំនួន (Quantity)
        let qty = 0;
        if (typeof l?.get_quantity === 'function') {
            try { qty = l.get_quantity(); } catch (_) {}
        }
        if (!qty && l?.quantity !== undefined) qty = Number(l.quantity);
        if (!qty && l?.qty !== undefined) qty = Number(l.qty);

        if ((!qty || isNaN(qty)) && el) {
            const qtyEl = el.querySelector?.('.qty, .quantity, em');
            if (qtyEl) {
                const m = (qtyEl.innerText || '').match(/([0-9]+(?:\.[0-9]+)?)/);
                if (m) qty = parseFloat(m[1]);
            }
            if (!qty) {
                const m = (el.innerText || '').match(/^([0-9]+)\s+/);
                if (m) qty = parseFloat(m[1]);
            }
        }
        if (!qty || isNaN(qty) || qty <= 0) qty = 1;

        // ៤. ស្រង់តម្លៃរាយ (Unit Price) និងតម្លៃសរុបប្រចាំជួរ (Line Total)
        let price = 0;
        let lineTotal = 0;

        if (typeof l?.get_unit_display_price === 'function') {
            try { price = l.get_unit_display_price(); } catch (_) {}
        }
        if (!price && typeof l?.get_unit_price === 'function') {
            try { price = l.get_unit_price(); } catch (_) {}
        }
        if (!price && typeof l?.get_display_price === 'function') {
            try { lineTotal = l.get_display_price(); } catch (_) {}
        }
        if (!lineTotal && typeof l?.get_price_with_tax === 'function') {
            try { lineTotal = l.get_price_with_tax(); } catch (_) {}
        }
        if (!lineTotal && typeof l?.get_price_without_tax === 'function') {
            try { lineTotal = l.get_price_without_tax(); } catch (_) {}
        }

        // Odoo 17/18 fields (price_unit, price_subtotal_incl)
        if (!price && l?.price_unit !== undefined) price = Number(l.price_unit);
        if (!price && l?.unit_price !== undefined) price = Number(l.unit_price);
        if (!price && l?.price !== undefined) price = Number(l.price);

        if (!lineTotal && l?.price_subtotal_incl !== undefined) lineTotal = Number(l.price_subtotal_incl);
        if (!lineTotal && l?.price_subtotal !== undefined) lineTotal = Number(l.price_subtotal);

        // តម្លៃពី Product Record
        if (!price && prod?.lst_price !== undefined) price = Number(prod.lst_price);
        if (!price && prod?.price !== undefined) price = Number(prod.price);

        // DOM Fallback សម្រាប់តម្លៃ
        if ((!price || price <= 0) && (!lineTotal || lineTotal <= 0) && el) {
            const priceEl = el.querySelector?.('.price, .product-price, .price-per-unit, [class*="price"]');
            if (priceEl) {
                const m = (priceEl.innerText || '').match(/\$\s*([0-9]+\.[0-9]{2})/);
                if (m) lineTotal = parseFloat(m[1]);
            }
            if (!lineTotal) {
                const matches = [...(el.innerText || '').matchAll(/\$\s*([0-9]+\.[0-9]{2})/g)];
                if (matches.length > 0) {
                    lineTotal = parseFloat(matches[matches.length - 1][1]);
                }
            }
        }

        if (!lineTotal && price > 0) lineTotal = price * qty;
        if (!price && lineTotal > 0 && qty > 0) price = lineTotal / qty;

        price = Number(price) || 0;
        lineTotal = Number(lineTotal) || (price * qty);

        name = cleanProductName(name, qty);
        if (!name) name = 'Item';

        // ៥. ស្រង់រូបភាព (Product Image)
        let img = null;
        // ទាញផ្ទាល់ពី Product Record ក្នុង Memory
        const rawImg = prod?.image_128 || prod?.image_256 || prod?.image_512 || l?.product_id?.image_128;
        if (rawImg && rawImg.length > 30) {
            img = rawImg.startsWith('data:') ? rawImg : `data:image/png;base64,${rawImg}`;
        }

        // DOM Image
        if (!img && el) {
            const domImg = el.querySelector('img');
            if (domImg && domImg.src && !domImg.src.includes('placeholder')) {
                img = getBase64FromImg(domImg) || domImg.src;
            }
        }

        // Search Catalog
        if (!img) {
            img = findProductImage(prodId, name, qty);
        }

        const uom = prod?.uom_id?.[1] || prod?.uom_id?.name || l?.product_uom_id?.name || l?.uom_name || '';

        return {
            name,
            price,
            qty,
            line_total: lineTotal,
            image: img || null,
            uom: uom || undefined
        };
    }

    /**
     * ស្រង់ទំនិញក្នុងកន្ត្រក (Orderlines)
     */
    function extractItems(pos) {
        // ស្រង់ DOM lines ក្នុង Left Pane (Cart)
        const domLines = Array.from(document.querySelectorAll(
            '.pos-leftpane .orderline, .order-widget .orderline, .orderlines .orderline, ul.orderlines li.orderline, .order-container .orderline, li.orderline'
        )).filter(l => !l.closest('.products-widget') && !l.closest('.product-list') && !l.closest('.product-screen .rightpane'));

        // ១. ស្រង់ពី Odoo POS Object (OWL Framework & Legacy)
        if (pos) {
            const order = pos.get_order?.() || pos.selectedOrder;
            if (order) {
                const rawLines = order.get_orderlines?.() || order.orderlines || order.lines || (typeof order.get_lines === 'function' ? order.get_lines() : null);
                if (Array.isArray(rawLines) || (rawLines && typeof rawLines.length === 'number')) {
                    const lines = Array.from(rawLines);
                    // ប្រសិនបើកន្ត្រក Odoo គ្មានទំនិញ (0 lines) ត្រូវប្រគល់ [] ភ្លាម
                    if (lines.length === 0) {
                        return [];
                    }

                    const extracted = lines.map((l, idx) => {
                        const matchingDomEl = domLines[idx] || null;
                        return extractLineDetails(l, matchingDomEl, pos, idx);
                    });

                    // ប្រសិនបើទាញបានទំនិញដែលមានឈ្មោះ និងតម្លៃត្រឹមត្រូវ ត្រឡប់វាភ្លាម
                    const validCount = extracted.filter(i => i.name && i.name !== 'Item' && i.price > 0).length;
                    if (validCount > 0 || domLines.length === 0) {
                        return extracted;
                    }
                }
            }
        }

        // ២. Fallback: ស្រង់ពី DOM lines ផ្ទាល់
        if (domLines.length > 0) {
            return domLines.map((el, idx) => {
                let compLine = null;
                try {
                    const comp = el.__owl__?.component;
                    compLine = comp?.props?.line || comp?.line || null;
                } catch (_) {}
                return extractLineDetails(compLine, el, pos, idx);
            });
        }

        return [];
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
                        const candidates = [
                            ord.tracking_number,
                            ord.sequence_number,
                            ord.get_name?.(),
                            ord.name,
                            ord.pos_reference,
                            ord.uid
                        ];
                        for (const c of candidates) {
                            if (c) {
                                const s = String(c).trim();
                                if (s && s !== '/' && s !== '-' && s !== 'false' && s !== 'undefined' && s.toLowerCase() !== 'order') {
                                    return s;
                                }
                            }
                        }
                    }
                } catch (_) {}
            }
            // ស្រង់ពី DOM Tab Bar ខាងលើ (ឧ. Tab "68003", "68002")
            const activeTab = document.querySelector(
                '.order-button.selected, .select-order.selected, .order-selector .selected, .ticket-button.active, .ticket-button.highlight, .pos-rightheader .order-button'
            );
            if (activeTab) {
                const txt = (activeTab.innerText || activeTab.textContent || '').trim();
                if (txt && !txt.includes('+') && !txt.toLowerCase().includes('order') && txt !== '/' && txt !== '-') {
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
        // E. ពិនិត្យថា Order ស្ថិតលើ ReceiptScreen (ទូទាត់រួច)
        // ──────────────────────────────────────────────────────────
        const currentOrder = pos?.get_order?.();
        const isFinalized = Boolean(currentOrder?.finalized);
        if (isReceipt || isFinalized) {
            cachedItems = [];
            cachedTotal = 0;
            cachedRef   = '';
            if (lastKey !== 'RESET_IDLE') {
                lastKey = 'RESET_IDLE';
                console.log('[POS Sync] ReceiptScreen / Order finalized active → resetting display to IDLE');
                GM_xmlhttpRequest({ method: 'POST', url: RESET_API });
            }
            return;
        }

        // ──────────────────────────────────────────────────────────
        // F. ស្រង់ Items, Total & Order Ref
        // ──────────────────────────────────────────────────────────
        let total = extractTotal(pos);
        let items = extractItems(pos);
        const currentRef = extractOrderRef(pos);

        // ប្រសិនបើដូរ Order Tab (ឧ. ពី 68003 ទៅ 68004) -> សម្អាត Cache ចាស់ចោលភ្លាម
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
            // Cart ទទេលើ ProductScreen (ឧ. Order ថ្មី 68004 ឬ Cancelled)
            cachedItems = [];
            cachedTotal = 0;
            total       = 0;

            if (lastKey !== 'RESET_IDLE') {
                lastKey = 'RESET_IDLE';
                console.log('[POS Sync] ProductScreen cart is empty → calling RESET to IDLE');
                GM_xmlhttpRequest({
                    method: 'POST',
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
                GM_xmlhttpRequest({ method: 'POST', url: RESET_API });
            }
            return;
        }

        // ──────────────────────────────────────────────────────────
        // H. Sync ទៅ Vercel តែប្រសិនបើ Key ផ្លាស់ប្ដូរ
        // ──────────────────────────────────────────────────────────
        const showQR   = isPayment;
        const orderRef = (currentRef && currentRef !== '/' && currentRef !== '-')
            ? currentRef
            : (cachedRef && cachedRef !== '/' && cachedRef !== '-')
                ? cachedRef
                : 'POS-' + Math.floor(1000 + Math.random() * 9000);
        const itemsKey = items.map(i => `${i.name}_${i.qty}_${i.price}_${i.image ? '1' : '0'}`).join('|');
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

    // ចាប់ Event Click ដើម្បី Sync ភ្លាមៗ (ចុច Payment, Validate, New Order, etc.)
    document.addEventListener('click', function(e) {
        const target = e.target;
        const btn = target?.closest?.('button.validate, .button.validate, button.validation, .payment-screen button.next, button.highlight, .pay-circle, [class*="validate"]');
        const txt = (target?.innerText || target?.textContent || '').trim().toLowerCase();

        // ប្រសិនបើចុចលើប៊ូតុង Validate ត្រូវកត់ត្រាថា Payment រួចរាល់ភ្លាម
        if (btn || txt === 'validate' || txt.includes('validate')) {
            console.log('🖱️ [POS Sync] Validate button clicked → resetting display to IDLE');
            try {
                cachedItems = [];
                cachedTotal = 0;
                cachedRef   = '';
                lastKey     = 'RESET_IDLE';

                // Call reset immediately so Customer Display stays in or returns to IDLE!
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${VERCEL_BASE}/api/reset?store=${getStoreId()}`
                });
            } catch (_) {}
        }

        // ចុចលើប៊ូតុង New Order (+) ឬដូរ Order Tab
        const newOrderBtn = target?.closest?.('.new-order, .order-button, .ticket-button, button.next');
        if (newOrderBtn || txt.includes('new order') || txt === '+') {
            cachedItems = [];
            cachedTotal = 0;
            cachedRef   = '';
            lastKey     = '';
        }

        setTimeout(checkPOS, 30);
        setTimeout(checkPOS, 200);
        setTimeout(checkPOS, 500);
    });

})();

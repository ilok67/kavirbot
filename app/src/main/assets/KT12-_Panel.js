// ==UserScript==
// @name         Kavirtire KT 12 - Fast Panel
// @namespace    http://tampermonkey.net/
// @version      2026-11-02-site-refresh-fix
// @description  KT11 professional panel: customer selects tire sizes, matching any product code
// @author       You
// @match        https://kavirtire.ir/esale/*
// @match        https://sep.shaparak.ir/OnlinePG/OnlinePG*
// @match        https://sep.shaparak.ir/OnlinePG/SendToken*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=kavirtire.ir
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const KT11_TOKEN_KEY = 'KT11_SAMAN_PAYMENT_TOKEN';
    const KT11_TOKEN_TIME_KEY = 'KT11_SAMAN_PAYMENT_TOKEN_TIME';
    const KT11_CUSTOMER_INFO_KEY = 'KT11_CUSTOMER_INFO_FOR_PAYMENT';
    const KT11_CARD_INFO_KEY = 'KT11_CARD_INFO_FOR_PAYMENT';
    const KT11_CARD_CVV_TEMP_KEY = 'KT11_CARD_CVV_TEMP';
    const KT11_CARD_CVV_TIME_KEY = 'KT11_CARD_CVV_TEMP_TIME';
    const KT11_CARD_CVV_TTL_MS = 6 * 60 * 1000;

    async function clearExpiredTemporaryCVV() {
        try {
            if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
            const timestamp = Number(await GM_getValue(KT11_CARD_CVV_TIME_KEY, 0)) || 0;
            if (!timestamp || Date.now() - timestamp > KT11_CARD_CVV_TTL_MS) {
                await GM_setValue(KT11_CARD_CVV_TEMP_KEY, '');
                await GM_setValue(KT11_CARD_CVV_TIME_KEY, 0);
            }
        } catch (_) {}
    }
    clearExpiredTemporaryCVV();

    function saveSamanToken(value) {
        if (typeof value !== 'string') return false;
        const token = value.trim();
        if (token.length < 8 || token.length > 4096 || /[\s<>"']/.test(token)) return false;
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(KT11_TOKEN_KEY, token);
                GM_setValue(KT11_TOKEN_TIME_KEY, Date.now());
                console.log('[KT11] SEP payment token captured from payment flow.');
                return true;
            }
        } catch (e) {
            console.warn('[KT11] Could not store SEP token:', e);
        }
        return false;
    }

    function findSamanToken(value, depth = 0, seen = new Set()) {
        // فقط samanToken مشخص یا توکنِ داخل لینک واقعی SendToken پذیرفته می‌شود؛
        // هر فیلدی که صرفاً نامش شامل token باشد ممکن است توکن نامرتبط باشد.
        if (depth > 7 || value == null) return '';
        if (typeof value === 'string') {
            const raw = value;
            const sendTokenUrl = raw.match(/https?:\/\/sep\.shaparak\.ir\/OnlinePG\/SendToken\?[^\s"'<>]*/i)
                || raw.match(/\/OnlinePG\/SendToken\?[^\s"'<>]*/i);
            if (sendTokenUrl) {
                try {
                    const u = new URL(sendTokenUrl[0], 'https://sep.shaparak.ir');
                    const t = u.searchParams.get('token');
                    if (t && t.trim().length >= 8) return t.trim();
                } catch (_) {}
            }
            // کویر تایر ممکن است HTML فرم پرداخت را به صورت رشته داخل wire:snapshot/JSON نگه دارد.
            // در این حالت فرم هنوز در DOM نیست؛ توکن را از input با name="Token" استخراج می‌کنیم.
            const inputTags = raw.match(/<input\b[^>]*>/gi) || [];
            for (const tag of inputTags) {
                const nameMatch = tag.match(/\bname\s*=\s*(["'])Token\1/i);
                if (!nameMatch) continue;
                const valueMatch = tag.match(/\bvalue\s*=\s*(["'])(.*?)\1/i);
                const htmlToken = valueMatch && valueMatch[2] ? valueMatch[2].trim() : '';
                if (htmlToken.length >= 8 && !/[\s<>]/.test(htmlToken)) return htmlToken;
            }
            const direct = raw.match(/["']?(?:samanToken|saman_token)["']?\s*[:=]\s*["']?([^"'\s,}&]{8,4096})/i);
            if (direct) return direct[1];
            if ((raw.startsWith('{') || raw.startsWith('[')) && raw.length < 2_000_000) {
                try { return findSamanToken(JSON.parse(raw), depth + 1, seen); } catch (_) {}
            }
            return '';
        }
        if (typeof value !== 'object' || seen.has(value)) return '';
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (/^saman_?token$/i.test(key) && typeof child === 'string' && child.trim().length >= 8) {
                return child.trim();
            }
            const nested = findSamanToken(child, depth + 1, seen);
            if (nested) return nested;
        }
        return '';
    }

    function scanStoredSamanToken() {
        try {
            for (const storage of [localStorage, sessionStorage]) {
                for (let i = 0; i < storage.length; i++) {
                    const key = storage.key(i) || '';
                    if (!/kavir|payment|gateway|saman|livewire/i.test(key)) continue;
                    const raw = storage.getItem(key);
                    if (!raw || raw.length > 2_000_000) continue;
                    const token = findSamanToken(raw);
                    if (token && saveSamanToken(token)) return true;
                }
            }
        } catch (_) {}
        return false;
    }

    function normalizeCardDigits(value) {
        return String(value || '').replace(/\D/g, '');
    }

    function setFieldValue(field, value) {
        if (!field || value == null) return false;
        const text = String(value);
        if (field.tagName === 'SELECT') {
            const options = [...field.options];
            const found = options.find(option => normalizeCardDigits(option.value) === normalizeCardDigits(text))
                || options.find(option => normalizeCardDigits(option.textContent) === normalizeCardDigits(text))
                || options.find(option => option.value === text || option.textContent.trim() === text);
            if (!found) return false;
            field.value = found.value;
        } else {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
            if (setter) setter.call(field, text); else field.value = text;
        }
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }

    function fieldDescriptor(field) {
        const label = field.id ? document.querySelector(`label[for="${CSS.escape(field.id)}"]`) : null;
        const parentText = field.parentElement?.textContent || '';
        return [field.name, field.id, field.placeholder, field.getAttribute('aria-label'), field.autocomplete,
            label?.textContent, parentText.length <= 80 ? parentText : '']
            .filter(Boolean).join(' ').toLowerCase();
    }

    async function autofillSEPCard() {
        if (location.hostname !== 'sep.shaparak.ir') return false;
        let card = {};
        let cvv = '';
        let cvvTime = 0;
        try {
            if (typeof GM_getValue === 'function') {
                card = await GM_getValue(KT11_CARD_INFO_KEY, {}) || {};
                cvv = await GM_getValue(KT11_CARD_CVV_TEMP_KEY, '') || '';
                cvvTime = Number(await GM_getValue(KT11_CARD_CVV_TIME_KEY, 0)) || 0;
            }
        } catch (_) { return false; }

        // CVV2 فقط برای تحویل یک‌باره و حداکثر شش دقیقه نگهداری می‌شود؛ پس از انقضا پاک می‌شود.
        if (!cvvTime || Date.now() - cvvTime > KT11_CARD_CVV_TTL_MS) {
            cvv = '';
            try {
                if (typeof GM_setValue === 'function') {
                    await GM_setValue(KT11_CARD_CVV_TEMP_KEY, '');
                    await GM_setValue(KT11_CARD_CVV_TIME_KEY, 0);
                }
            } catch (_) {}
        }
        const cardNumber = normalizeCardDigits(card.number);
        if (!cardNumber) return false;

        const fields = [...document.querySelectorAll('input, select')]
            .filter(field => !field.disabled && field.type !== 'hidden' && field.offsetParent !== null);
        const descriptors = fields.map(field => ({ field, desc: fieldDescriptor(field) }));
        const findField = (regex, exclude = null) => descriptors.find(item => regex.test(item.desc) && (!exclude || !exclude.test(item.desc)))?.field;

        const numberField = findField(/card.?number|cardno|pan|شماره\s*کارت|شمارهکارت/i, /cvv|cvc|month|year|ماه|سال/i);
        const cvvField = findField(/cvv\s*2?|cvc|security.?code|card.?security|کد\s*امنیتی|کد\s*امنیت|رمز\s*کارت/i);
        const monthField = findField(/expire.?month|exp.?month|expiry.?month|month|ماه\s*انقضا|انقضا.*ماه/i, /year|سال/i);
        const yearField = findField(/expire.?year|exp.?year|expiry.?year|year|سال\s*انقضا|انقضا.*سال/i, /month|ماه/i);

        const numberFilled = !!numberField && setFieldValue(numberField, cardNumber);
        const cvvFilled = !!(cvv && cvvField && setFieldValue(cvvField, cvv));
        let monthFilled = false;
        let yearFilled = false;
        if (monthField && card.month) {
            monthFilled = setFieldValue(monthField, String(card.month).padStart(2, '0'))
                || setFieldValue(monthField, String(Number(card.month)));
        }
        if (yearField && card.year) {
            const year = String(card.year);
            yearFilled = setFieldValue(yearField, year) || setFieldValue(yearField, year.slice(-2));
        }

        // فقط وقتی فیلدهای اصلی پیدا و پر شدند، تلاش خودکار متوقف می‌شود.
        const done = numberFilled && monthFilled && yearFilled;
        if (done) {
            const note = document.getElementById('kt11-sep-note');
            if (note) note.textContent = cvvFilled
                ? 'اطلاعات کارت در فیلدهای درگاه وارد شد؛ اطلاعات را بررسی کن و پرداخت را خودت تأیید کن.'
                : 'شماره کارت و تاریخ انقضا وارد شد. CVV2 را در صورت نیاز وارد کن و پرداخت را خودت تأیید کن.';
            if (cvvFilled) {
                try {
                    await GM_setValue(KT11_CARD_CVV_TEMP_KEY, '');
                    await GM_setValue(KT11_CARD_CVV_TIME_KEY, 0);
                } catch (_) {}
            }
        }
        return done;
    }

    function startSEPCardAutofill() {
        let attempts = 0;
        const timer = setInterval(async () => {
            attempts++;
            const done = await autofillSEPCard();
            if (done || attempts >= 40) clearInterval(timer);
        }, 500);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => autofillSEPCard(), { once: true });
        }
    }

    function installPaymentTokenCapture() {
        if (location.hostname !== 'kavirtire.ir') return;
        scanStoredSamanToken();

        // قبل از ارسال فرم به درگاه، فیلدهای توکن فرم را می‌خوانیم؛ این حالت در ارسال POST قابل‌مشاهده در URL نیست.
        function capturePaymentForm(form) {
            if (!(form instanceof HTMLFormElement)) return false;
            const action = String(form.action || form.getAttribute('action') || '');
            // گاهی توکن داخل query خود action قرار دارد.
            try {
                const actionUrl = new URL(action, location.href);
                if (/sep\.shaparak\.ir|onlinepg/i.test(actionUrl.href)) {
                    const actionToken = actionUrl.searchParams.get('token') || actionUrl.searchParams.get('samanToken') || actionUrl.searchParams.get('paymentToken');
                    if (actionToken && saveSamanToken(actionToken)) return true;
                }
            } catch (_) {}
            const isSepAction = /sep\.shaparak\.ir|onlinepg/i.test(action);
            const fields = [...form.querySelectorAll('input[name], textarea[name]')];
            const tokenField = fields.find(el => /^saman_?token$/i.test(el.name))
                || (isSepAction ? fields.find(el => /^token$/i.test(el.name)) : null);
            if (!tokenField || !tokenField.value) return false;
            if (!isSepAction && location.pathname !== '/esale/payment') return false;
            return saveSamanToken(tokenField.value);
        }
        document.addEventListener('submit', event => capturePaymentForm(event.target), true);
        const originalFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function (...args) {
            capturePaymentForm(this);
            return originalFormSubmit.apply(this, args);
        };
        if (HTMLFormElement.prototype.requestSubmit) {
            const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
            HTMLFormElement.prototype.requestSubmit = function (...args) {
                capturePaymentForm(this);
                return originalRequestSubmit.apply(this, args);
            };
        }
        // اسکن فرم‌های موجود و پارامترهای ورودی صفحه، محدود به فرم/فیلدهای دارای نام توکن.
        const scanPaymentForms = () => {
            try {
                for (const form of document.forms) if (capturePaymentForm(form)) return true;
                for (const link of document.querySelectorAll('a[href]')) {
                    try {
                        const u = new URL(link.href, location.href);
                        if (!/sep\.shaparak\.ir|onlinepg/i.test(u.href)) continue;
                        const t = u.searchParams.get('token') || u.searchParams.get('samanToken') || u.searchParams.get('paymentToken');
                        if (t && saveSamanToken(t)) return true;
                    } catch (_) {}
                }
                for (const el of document.querySelectorAll('input[name], textarea[name]')) {
                    const form = el.form;
                    const exactSamanField = /^saman_?token$/i.test(el.name);
                    const sepTokenField = /^token$/i.test(el.name) && form && /sep\.shaparak\.ir|onlinepg/i.test(String(form.action || ''));
                    if ((exactSamanField || sepTokenField) && el.value) {
                        if (saveSamanToken(el.value)) return true;
                    }
                }
            } catch (_) {}
            return false;
        };
        document.addEventListener('DOMContentLoaded', scanPaymentForms, { once: true });

        // پاسخ‌های مربوط به پرداخت/Livewire را سبک بررسی می‌کنیم؛ اطلاعات کارت بانکی خوانده یا ذخیره نمی‌شود.
        if (typeof window.fetch === 'function' && !window.fetch.__kt11TokenMonitor) {
            const originalFetch = window.fetch;
            const wrappedFetch = function (...args) {
                try {
                    const init = args[1];
                    const body = init && init.body;
                    if (typeof body === 'string') {
                        const token = findSamanToken(body);
                        if (token) saveSamanToken(token);
                    } else if (body instanceof URLSearchParams) {
                        const token = findSamanToken(body.toString());
                        if (token) saveSamanToken(token);
                    } else if (body instanceof FormData) {
                        for (const [key, value] of body.entries()) {
                            if (/token/i.test(key) && !/csrf|verification|xsrf/i.test(key) && typeof value === 'string' && saveSamanToken(value)) break;
                        }
                    }
                } catch (_) {}
                const result = originalFetch.apply(this, args);
                Promise.resolve(result).then(response => {
                    const url = String(response?.url || args[0]?.url || args[0] || '');
                    if (!/livewire|payment|gateway|esale/i.test(url)) return;
                    try {
                        response.clone().text().then(body => {
                            const token = findSamanToken(body);
                            if (token) saveSamanToken(token);
                        }).catch(() => {});
                    } catch (_) {}
                }).catch(() => {});
                return result;
            };
            wrappedFetch.__kt11TokenMonitor = true;
            window.fetch = wrappedFetch;
        }

        if (!XMLHttpRequest.prototype.send.__kt11TokenMonitor) {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__kt11Url = String(url || '');
                return originalOpen.call(this, method, url, ...rest);
            };
            const wrappedSend = function (...args) {
                try {
                    const body = args[0];
                    if (typeof body === 'string' && (/livewire|payment|gateway|esale|sep\.shaparak/i.test(this.__kt11Url || '') || /(?:^|&)(?:token|samanToken|paymentToken|gatewayToken)=/i.test(body))) {
                        const token = findSamanToken(body);
                        if (token) saveSamanToken(token);
                    } else if (body instanceof FormData) {
                        for (const [key, value] of body.entries()) {
                            if (/token/i.test(key) && !/csrf|verification|xsrf/i.test(key) && typeof value === 'string' && saveSamanToken(value)) break;
                        }
                    }
                } catch (_) {}
                this.addEventListener('load', function () {
                    if (!/livewire|payment|gateway|esale/i.test(this.__kt11Url || '')) return;
                    try {
                        const token = findSamanToken(this.responseText);
                        if (token) saveSamanToken(token);
                    } catch (_) {}
                }, { once: true });
                return originalSend.apply(this, args);
            };
            wrappedSend.__kt11TokenMonitor = true;
            XMLHttpRequest.prototype.send = wrappedSend;
        }

        // محدود و زمان‌دار؛ از اسکن بی‌نهایت صفحه جلوگیری می‌کند.
        let scans = 0;
        const scanTimer = setInterval(() => {
            scans++;
            if (scanStoredSamanToken() || (document.readyState !== 'loading' && (() => { try { for (const form of document.forms) if (form.querySelector('input[name*=token i],textarea[name*=token i]') && capturePaymentForm(form)) return true; } catch (_) {} return false; })()) || scans >= 30) clearInterval(scanTimer);
        }, 500);
    }

    // اگر مرورگر لحظه‌ای از مسیر SendToken عبور کند، توکن را پیش از ادامه مسیر ذخیره می‌کنیم.
    if (location.hostname === 'sep.shaparak.ir' && location.pathname.startsWith('/OnlinePG/')) {
        try {
            const currentParams = new URL(location.href).searchParams;
            const directToken = currentParams.get('token') || currentParams.get('samanToken');
            if (directToken) saveSamanToken(directToken);
        } catch (_) {}
    }

    // درگاه از حافظه مشترک Tampermonkey توکنِ به‌دست‌آمده از مرحله پرداخت را می‌خواند.
    if (location.hostname === 'sep.shaparak.ir' && location.pathname.startsWith('/OnlinePG/')) {
        const mountSEPHelper = () => {
            if (!document.body || document.getElementById('kt11-sep-helper')) return;
            const box = document.createElement('div');
            box.id = 'kt11-sep-helper';
            box.dir = 'rtl';
            box.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;width:310px;max-width:calc(100vw - 32px);padding:14px;background:#171717;color:#fff;border:1px solid #d5a900;border-radius:12px;box-shadow:0 6px 24px #0008;font:13px/1.7 Tahoma,sans-serif;';
            box.innerHTML = '<b style="display:block;margin-bottom:6px;color:#ffd43b;font-size:15px">لینک پرداخت KT11</b><div id="kt11-sep-note" style="margin-bottom:8px">در حال بررسی توکن پرداخت…</div><input id="kt11-sep-link" type="text" readonly dir="ltr" placeholder="لینک پرداخت پس از دریافت توکن نمایش داده می‌شود" style="box-sizing:border-box;width:100%;padding:9px;margin:0 0 8px;border:1px solid #555;border-radius:7px;background:#242424;color:#fff;font:12px/1.5 Tahoma,sans-serif;"/><button id="kt11-sep-copy" type="button" style="width:100%;padding:10px;border:0;border-radius:7px;background:#d5a900;color:#111;font-weight:bold;cursor:pointer">کپی لینک پرداخت</button><button id="kt11-sep-close" type="button" style="margin-top:6px;width:100%;padding:7px;border:1px solid #777;border-radius:7px;background:transparent;color:#fff;cursor:pointer">بستن پنل</button>';
            document.body.appendChild(box);
            startSEPCardAutofill();
            const note = box.querySelector('#kt11-sep-note');
            const linkField = box.querySelector('#kt11-sep-link');
            const copyButton = box.querySelector('#kt11-sep-copy');
            async function getPaymentLink() {
                let token = '';
                try {
                    const params = new URL(location.href).searchParams;
                    token = params.get('token') || params.get('samanToken') || params.get('paymentToken') || '';
                } catch (_) {}
                if (!token && typeof GM_getValue === 'function') {
                    try { token = await GM_getValue(KT11_TOKEN_KEY, ''); } catch (_) {}
                }
                if (!token) return '';
                // توکن به لینک استاندارد پرداخت سامان تبدیل می‌شود.
                return 'https://sep.shaparak.ir/OnlinePG/SendToken?token=' + encodeURIComponent(token);
            }
            async function refreshPaymentLink() {
                const link = await getPaymentLink();
                if (link) {
                    linkField.value = link;
                    note.textContent = 'لینک پرداخت آماده است. آن را فقط برای پرداخت‌کننده موردنظر ارسال کن.';
                    copyButton.disabled = false;
                    return true;
                }
                linkField.value = '';
                note.textContent = 'توکن هنوز دریافت نشده؛ اگر صفحه پرداخت کویر تایر را تازه ترک کردی، چند ثانیه صبر کن.';
                copyButton.disabled = true;
                return false;
            }
            box.querySelector('#kt11-sep-close').addEventListener('click', () => box.remove());
            copyButton.addEventListener('click', async () => {
                const link = await getPaymentLink();
                if (!link) {
                    note.textContent = 'توکن پیدا نشد. باید پیش از ورود به درگاه، مرحله پرداخت کویر تایر در همان مرورگر باز و اسکریپت فعال باشد.';
                    return;
                }
                linkField.value = link;
                let customer = {};
                try {
                    if (typeof GM_getValue === 'function') {
                        customer = await GM_getValue(KT11_CUSTOMER_INFO_KEY, {}) || {};
                    }
                } catch (_) {}
                const message = [
                    'نام و نام خانوادگی: ' + (customer.name || 'ثبت نشده'),
                    'کد ملی: ' + (customer.nationalCode || 'ثبت نشده'),
                    'موبایل: ' + (customer.phone || 'ثبت نشده'),
                    'خودرو: ' + (customer.car || 'ثبت نشده'),
                    'لینک درگاه:',
                    link,
                    'لطفاً سریع پرداخت کنید.'
                ].join('\n');
                try {
                    if (navigator.clipboard && window.isSecureContext) {
                        await navigator.clipboard.writeText(message);
                    } else {
                        const temp = document.createElement('textarea');
                        temp.value = message;
                        temp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
                        document.body.appendChild(temp);
                        temp.focus(); temp.select();
                        const copied = document.execCommand('copy');
                        temp.remove();
                        if (!copied) throw new Error('copy failed');
                    }
                    note.textContent = 'اطلاعات مشتری و لینک درگاه با هم کپی شدند.';
                } catch (_) {
                    const temp = document.createElement('textarea');
                    temp.value = message;
                    temp.style.cssText = 'box-sizing:border-box;width:100%;height:150px;margin-top:8px;padding:8px;direction:rtl;background:#242424;color:#fff;border:1px solid #777;border-radius:7px;';
                    const old = box.querySelector('#kt11-sep-copy-message');
                    if (old) old.remove();
                    temp.id = 'kt11-sep-copy-message';
                    box.appendChild(temp);
                    temp.focus(); temp.select();
                    note.textContent = 'متن کامل آماده است؛ آن را انتخاب و دستی کپی کن.';
                }
            });
            refreshPaymentLink();
            const tokenRefreshTimer = setInterval(() => {
                if (!document.getElementById('kt11-sep-helper')) { clearInterval(tokenRefreshTimer); return; }
                refreshPaymentLink();
            }, 700);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSEPHelper, { once: true });
        else mountSEPHelper();
        return;
    }

    installPaymentTokenCapture();

    /* =========================================================
       تنظیمات پایه
       ========================================================= */

    const FAST_CHECK_INTERVAL = 200;
    const STEP_INTERVAL = 100;
    const REFRESH_INTERVAL = 4100;
    const BAD_GATEWAY_RETRY = 400;
    const BAD_GATEWAY_COOLDOWN = 350;

    const TELEGRAM_URL =
        'https://t.me/kavir_tire_bot';

    const STORAGE_KEY =
        'KT11_USER_SETTINGS';


    /* =========================================================
       لیست محصولات
       ========================================================= */

    const productOptions = [
        { code: 'KB12', size: '165/65/13' },
        { code: 'KB26', size: '165/65/13' },
        { code: 'KB2000', size: '175/60/13' },
        { code: 'KB88', size: '185/60/14' },
        { code: 'KB36', size: '175/70/13' },
        { code: 'KB27', size: '185/65/14' },
        { code: 'KB22', size: '185/65/14' },
        { code: 'KB77', size: '205/60/14' },
        { code: 'KB44', size: '205/60/14' },
        { code: 'KB33', size: '195/60/15' },
        { code: 'KB27', size: '185/65/15' },
        { code: 'KB22', size: '185/65/15' },
        { code: 'KB77', size: '205/60/15' },
        { code: 'KB44', size: '205/60/15' },
        { code: 'KB47', size: '195/65/15' },
        { code: 'KB44', size: '205/50/16' },
        { code: 'KB55', size: '205/55/16' },
        { code: 'KB700', size: '235/65/17' },
        { code: 'KB66', size: '215/60/17' }
    ];


    /* =========================================================
       تنظیمات پیش‌فرض
       ========================================================= */

    const DEFAULT_SETTINGS = {
        quantity: 2,
        product1: {
            code: 'KB12',
            size: '165/65/13',
            quantity: 2
        },
        product2: {
            code: 'KB26',
            size: '165/65/13',
            quantity: 2
        }
    };


    /* =========================================================
       دریافت تنظیمات ذخیره‌شده
       ========================================================= */

    function loadSettings() {

        try {

            const saved =
                localStorage.getItem(
                    STORAGE_KEY
                );

            if (!saved) {

                return JSON.parse(
                    JSON.stringify(
                        DEFAULT_SETTINGS
                    )
                );

            }

            const parsed =
                JSON.parse(saved);

            // پشتیبانی از تنظیمات قدیمی: اگر quantity کلی ذخیره نشده باشد،
            // مقدار معتبر قبلی محصول اول (۱ یا ۲) به عنوان مقدار کلی استفاده می‌شود.
            const legacyQuantity = Number(parsed.product1?.quantity);
            const savedQuantity = Number(parsed.quantity);
            const quantity = [1, 2].includes(savedQuantity)
                ? savedQuantity
                : ([1, 2].includes(legacyQuantity) ? legacyQuantity : 2);

            const product1 = normalizeProduct(parsed.product1, DEFAULT_SETTINGS.product1);
            const product2 = normalizeProduct(parsed.product2, DEFAULT_SETTINGS.product2);
            product1.quantity = quantity;
            product2.quantity = quantity;

            return { quantity, product1, product2 };

        } catch (error) {

            console.error(
                'KT11 settings error:',
                error
            );

            return JSON.parse(
                JSON.stringify(
                    DEFAULT_SETTINGS
                )
            );

        }

    }


    function normalizeProduct(
        product,
        fallback
    ) {

        if (!product) {
            return {
                ...fallback
            };
        }

        const validOption = productOptions.some(option =>
            option.code === product.code && option.size === product.size
        );

        if (!validOption) {

            return {
                ...fallback
            };

        }

        const quantity =
            Number(product.quantity);

        return {

            code:
                product.code,

            size:
                product.size,

            quantity:
                Number.isInteger(quantity) &&
                quantity >= 1 &&
                quantity <= 4
                    ? quantity
                    : fallback.quantity

        };

    }


    let settings =
        loadSettings();


    /* =========================================================
       محصولات فعال
       ========================================================= */

    const product1 = {
        ...settings.product1,
        name: settings.product1.code
    };

    const product2 = {
        ...settings.product2,
        name: settings.product2.code
    };

    const products = [product1, product2];

    function productKey(product) {
        return `${product.code}|${product.size}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    }



    /* =========================================================
       انتخابگرها
       ========================================================= */

    const SELECTORS = {

        product:
            '.product',

        title:
            '.title',

        unavailable:
            '.control.unavailable',

        basket:
            '.btn-basket',

        minus:
            'button[wire\\:click="minus()"]',

        gateway:
            '.method[wire\\:click="setGateway(\'refahk\')"]',

        active:
            'active',

        next:
            'a[wire\\:click="next()"]'

    };


    /* =========================================================
       وضعیت ربات
       ========================================================= */

    // وضعیت ON/OFF بین جابه‌جایی صفحات سایت حفظ می‌شود؛
    // در اولین نصب، مقدار پیش‌فرض روشن است.
    const BOT_ENABLED_STORAGE_KEY = 'KT11_BOT_ENABLED';

    function readSavedBotEnabled() {
        try {
            const saved = localStorage.getItem(BOT_ENABLED_STORAGE_KEY);
            if (saved === '0') return false;
            if (saved === '1') return true;
        } catch (_) {}
        return true;
    }

    function saveBotEnabledState() {
        try {
            localStorage.setItem(BOT_ENABLED_STORAGE_KEY, botEnabled ? '1' : '0');
        } catch (_) {}
    }

    let botEnabled = readSavedBotEnabled();

    let purchaseStarted = false;

    let selectedProduct = null;

    let pollTimer = null;
    let reloadTimer = null;
    let refreshTimer = null;
    let fastObserver = null;
    let observerCheckTimer = null;
    let last502PageCheck = 0;
    let observerStarted = false;
    let botLocked = false;
    let gatewayRecoveryRunning = false;
    let lastGatewayRecovery = 0;
    // شمارنده فقط با کلیک واقعی روی «بروزرسانی موجودی» زیاد می‌شود و بین صفحات همین تب حفظ می‌شود.
    const CHECK_COUNT_STORAGE_KEY = 'KT11_CHECK_COUNT';
    const LAST_CHECK_AT_STORAGE_KEY = 'KT11_LAST_CHECK_AT';
    let checkCount = 0;
    let lastCheckAt = 0;
    try {
        checkCount = Math.max(0, Number(sessionStorage.getItem(CHECK_COUNT_STORAGE_KEY)) || 0);
        lastCheckAt = Math.max(0, Number(sessionStorage.getItem(LAST_CHECK_AT_STORAGE_KEY)) || 0);
    } catch (_) {}
    let addedProducts = [];
    let lastInfoUpdate = 0;


    const productStates = {};


    function rebuildProductStates() {

        Object.keys(
            productStates
        ).forEach(key => {
            delete productStates[key];
        });

        products.forEach(product => {

            productStates[productKey(product)] = {

                status:
                    'waiting',

                text:
                    'در انتظار'

            };

        });

    }


    rebuildProductStates();


    /* =========================================================
       ساخت گزینه‌های محصولات
       ========================================================= */

    function getProductOptionsHTML(
        selectedProduct
    ) {
        const sizes = [...new Set(productOptions.map(product => product.size))];
        return sizes.map(size => {
            const selected = size === selectedProduct.size ? 'selected' : '';
            return `
                <option value="${size}" ${selected}>${size}</option>
            `;
        }).join('');
    }

    function getQuantityOptionsHTML(
        quantity
    ) {

        return [1, 2]
            .map(number => {

                return `
                    <option
                        value="${number}"
                        ${number === quantity ? 'selected' : ''}
                    >
                        ${number} حلقه
                    </option>
                `;

            })
            .join('');

    }


    /* =========================================================
       ساخت داشبورد
       ========================================================= */

    function createDashboard() {

        if (
            document.getElementById(
                'kt11-dashboard'
            )
        ) {
            return;
        }

        if (!document.body) {

            setTimeout(
                createDashboard,
                100
            );

            return;
        }


        const panel =
            document.createElement('div');

        panel.id =
            'kt11-dashboard';


        panel.innerHTML = `

            <div id="kt11-head">

                <div>

                    <div id="kt11-title">
                        🤖 ربات کویر تایر
                    </div>

                    <div id="kt11-version">
                        KT 11 • CONTROL PANEL
                    </div>

                </div>

                <div id="kt11-head-actions">
                    <button id="kt11-compact-toggle" type="button" aria-expanded="true" title="جمع کردن پنل">□</button>
                </div>

            </div>


            <div id="kt11-control">

                <div id="kt11-control-text">

                    <div id="kt11-power-label">
                        وضعیت ربات
                    </div>

                    <div id="kt11-power-status">
                        🟢 روشن
                    </div>

                </div>

                <button
                    id="kt11-power-button"
                    type="button"
                >
                    ON
                </button>

            </div>


            <div id="kt11-main-status">

                <span id="kt11-main-icon">
                    🤖
                </span>

                <span id="kt11-main-text">
                    در حال آماده‌سازی...
                </span>

            </div>


            <!-- تنظیمات -->

            <button
                id="kt11-settings-toggle"
                type="button"
            >
                <span>
                    ⚙️ تنظیمات خرید
                </span>

                <span id="kt11-settings-arrow">
                    ▼
                </span>

            </button>


            <div
                id="kt11-settings-panel"
                style="display:none;"
            >

                <div class="kt11-setting-title">
                    اولویت اول - سایز لاستیک
                </div>

                <select
                    id="kt11-product-select-1"
                    class="kt11-select"
                >
                    ${getProductOptionsHTML(product1)}
                </select>

                <div class="kt11-setting-title">
                    اولویت دوم - سایز لاستیک
                </div>

                <select
                    id="kt11-product-select-2"
                    class="kt11-select"
                >
                    ${getProductOptionsHTML(product2)}
                </select>

                <div class="kt11-setting-title">
                    تعداد کل حلقه‌های خرید (حداکثر ۲ حلقه)
                </div>

                <select
                    id="kt11-total-quantity"
                    class="kt11-select"
                >
                    ${getQuantityOptionsHTML(settings.quantity)}
                </select>


                <button
                    id="kt11-save-settings"
                    type="button"
                >
                    ✓ ذخیره تنظیمات
                </button>

                <div
                    id="kt11-settings-message"
                ></div>

            </div>


            <!-- اطلاعات مشتری -->
            <button
                id="kt11-customer-toggle"
                type="button"
                aria-expanded="false"
            >
                <span>👤 اطلاعات مشتری</span>
                <span id="kt11-customer-arrow">▼</span>
            </button>

            <div
                id="kt11-customer-panel"
                style="display:none;"
            >
                <div class="kt11-customer-row">
                    <span>نام و نام خانوادگی</span>
                    <strong id="kt11-customer-name">در حال دریافت...</strong>
                </div>
                <div class="kt11-customer-row">
                    <span>کد ملی</span>
                    <strong id="kt11-customer-national-code">در حال دریافت...</strong>
                </div>
                <div class="kt11-customer-row">
                    <span>شماره موبایل</span>
                    <strong id="kt11-customer-phone">در حال دریافت...</strong>
                </div>
                <div class="kt11-customer-row">
                    <span>خودرو</span>
                    <strong id="kt11-customer-car">در حال دریافت...</strong>
                </div>
                <button id="kt11-customer-refresh" type="button">↻ دریافت مجدد اطلاعات</button>
            </div>

            <!-- اطلاعات کارت بانکی -->
            <button id="kt11-card-toggle" type="button" aria-expanded="false">
                <span>💳 اطلاعات کارت</span>
                <span id="kt11-card-arrow">▼</span>
            </button>
            <div id="kt11-card-panel" style="display:none;">
                <label class="kt11-card-label" for="kt11-card-number">شماره کارت</label>
                <input id="kt11-card-number" class="kt11-card-input" type="text" inputmode="numeric" autocomplete="cc-number" maxlength="23" placeholder="۱۶ رقم شماره کارت" dir="ltr">
                <label class="kt11-card-label" for="kt11-card-cvv">CVV2</label>
                <input id="kt11-card-cvv" class="kt11-card-input" type="password" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="۳ یا ۴ رقم" dir="ltr">
                <div class="kt11-card-expiry">
                    <div><label class="kt11-card-label" for="kt11-card-month">انقضا (ماه)</label><input id="kt11-card-month" class="kt11-card-input" type="text" inputmode="numeric" maxlength="2" placeholder="MM" dir="ltr"></div>
                    <div><label class="kt11-card-label" for="kt11-card-year">انقضا (سال)</label><input id="kt11-card-year" class="kt11-card-input" type="text" inputmode="numeric" maxlength="2" placeholder="YY" dir="ltr"></div>
                </div>
                <button id="kt11-card-save" type="button">✓ ذخیره اطلاعات کارت</button>
                <div id="kt11-card-message" role="status"></div>
                <small class="kt11-card-hint">فقط یک کارت میتوانید ذخیره کنید</small>
            </div>

            <div id="kt11-products-title">

                <div>
                    📦 محصولات تحت نظر
                </div>

                <span>
                    ${products.length} محصول
                </span>

            </div>


            <div id="kt11-products">

                ${products.map(product => `

                    <div
                        class="kt11-product"
                        id="kt11-product-${productKey(product)}"
                    >

                        <div class="kt11-product-top">

                            <span class="kt11-product-code">
                                ${product.code}
                            </span>

                            <span
                                class="kt11-product-badge"
                                id="kt11-badge-${productKey(product)}"
                            >
                                در انتظار
                            </span>

                        </div>

                        <div class="kt11-product-size">
                            سایز: ${product.size}
                        </div>

                        <div class="kt11-product-quantity">
                            تعداد درخواستی:
                            <b>${product.quantity}</b>
                            حلقه
                        </div>

                    </div>

                `).join('')}

            </div>


            <div id="kt11-info">

                <div class="kt11-info-row">

                    <span>
                        🔍 آخرین بررسی
                    </span>

                    <b id="kt11-last-check">
                        --
                    </b>

                </div>


                <div class="kt11-info-row">

                    <span>
                        🔄 تعداد بررسی
                    </span>

                    <b id="kt11-check-count">
                        0
                    </b>

                </div>

            </div>


            <div id="kt11-connection">

                <div id="kt11-connection-top">

                    <div id="kt11-connection-icon">
                        ✓
                    </div>

                    <div>

                        <div id="kt11-connection-title">
                            اتصال به سرور
                        </div>

                        <div id="kt11-connection-status">
                            موفق
                        </div>

                    </div>

                </div>

            </div>


            <div
                id="kt11-support-box"
                title="ورود به کانال تلگرام"
                role="link"
                tabindex="0"
            >

                <div id="kt11-support-icon">
                    🎧
                </div>

                <div id="kt11-support-content">

                    <div id="kt11-support-title">
                        خرید و پشتیبانی ربات
                    </div>

                    <div id="kt11-support-subtitle">
                        برای دریافت نسخه ربات و پشتیبانی
                    </div>

                    <div id="kt11-support-id">
                        @Kavir_tire_bot
                    </div>

                </div>

                <div id="kt11-support-arrow">
                    ‹
                </div>

            </div>

        `;


        panel.style.cssText = `

            position:fixed !important;

            top:15px !important;
            right:15px !important;

            width:290px !important;

            max-width:
                calc(100vw - 30px) !important;

            background:
                linear-gradient(
                    145deg,
                    #171717,
                    #252525
                ) !important;

            color:#ffffff !important;

            border:
                2px solid #444 !important;

            border-radius:
                13px !important;

            padding:
                12px !important;

            z-index:
                2147483647 !important;

            font-family:
                Tahoma,
                Arial,
                sans-serif !important;

            direction:
                rtl !important;

            text-align:
                right !important;

            box-shadow:
                0 7px 27px
                rgba(0,0,0,0.5) !important;

            box-sizing:
                border-box !important;

            /* پنل باید قابل کلیک باشد؛ none باعث می‌شد دکمه‌ها عمل نکنند */
            pointer-events:
                auto !important;

        `;


        const style =
            document.createElement('style');

        style.id =
            'kt11-dashboard-style';


        style.textContent = `

            #kt11-dashboard * {
                box-sizing:border-box;
            }


            #kt11-head {

                display:flex;
                align-items:center;
                justify-content:space-between;

                margin-bottom:9px;
                padding-bottom:8px;

                border-bottom:
                    1px solid #444;
            }


            #kt11-title {

                font-size:17px;
                font-weight:bold;
                color:#ffd000;
            }


            #kt11-version {

                font-size:9px;
                color:#999;
                margin-top:2px;
            }


            #kt11-head-actions { display:flex; align-items:center; gap:8px; }
            #kt11-compact-toggle {
                display:inline-flex; align-items:center; justify-content:center;
                width:27px; height:25px; padding:0; border:1px solid #777;
                border-radius:5px; background:#292929; color:#ffd000;
                font: bold 17px/1 Tahoma,sans-serif; cursor:pointer;
                flex:0 0 auto; position:relative; z-index:10;
            }
            #kt11-compact-toggle:hover { background:#383838; }
            #kt11-compact-toggle:focus { outline:1px solid #ffd000; outline-offset:1px; }
            #kt11-dashboard.kt11-compact { padding-bottom:8px !important; }
            #kt11-dashboard.kt11-compact > :not(#kt11-head):not(#kt11-control):not(#kt11-main-status) { display:none !important; }
            #kt11-dashboard.kt11-compact #kt11-head { margin-bottom:7px; padding-bottom:6px; }
            #kt11-dashboard.kt11-compact #kt11-version { display:none !important; }
            #kt11-dashboard.kt11-compact #kt11-title { font-size:14px; }
            #kt11-dashboard.kt11-compact #kt11-control { margin-bottom:6px; }
            #kt11-dashboard.kt11-compact #kt11-main-status { margin-bottom:0; }

            /* ON / OFF */

            #kt11-control {

                display:flex;
                align-items:center;
                justify-content:space-between;

                gap:9px;

                background:#202020;
                border-radius:9px;

                padding:9px;
                margin-bottom:9px;
            }


            #kt11-power-label {

                font-size:9px;
                color:#999;
                margin-bottom:1px;
            }


            #kt11-power-status {

                font-size:14px;
                font-weight:bold;
            }


            #kt11-power-button {

                width:70px;
                height:36px;

                border:0;
                border-radius:8px;

                font-family:
                    Tahoma,
                    Arial,
                    sans-serif;

                font-size:13px;
                font-weight:bold;

                cursor:pointer;

                pointer-events:
                    auto !important;

                transition:
                    transform .1s,
                    opacity .1s;
            }


            #kt11-power-button:active {

                transform:
                    scale(.96);
            }


            #kt11-power-button.on {

                background:#1fa34a;
                color:white;
            }


            #kt11-power-button.off {

                background:#b52b2b;
                color:white;
            }


            /* وضعیت اصلی */

            #kt11-main-status {

                background:#202020;

                border-radius:8px;

                padding:9px;

                margin-bottom:8px;

                font-size:13px;
                font-weight:bold;

                display:flex;
                align-items:center;

                gap:6px;
            }


            #kt11-main-icon {

                font-size:18px;
            }


            /* انیمیشن ساعت شنی */

            #kt11-main-icon.kt11-hourglass {

                display:inline-block;

                animation:
                    kt11HourglassSpin
                    1.2s
                    linear
                    infinite;

                transform-origin:
                    center center;
            }


            @keyframes kt11HourglassSpin {

                0% {
                    transform:
                        rotate(0deg);
                }

                100% {
                    transform:
                        rotate(360deg);
                }

            }


            /* =================================================
               تنظیمات
               ================================================= */

            #kt11-settings-toggle {

                width:100%;

                display:flex;
                align-items:center;
                justify-content:space-between;

                background:#202020;

                border:
                    1px solid #3d3d3d;

                border-radius:8px;

                padding:8px 10px;

                margin-bottom:6px;

                color:#ffd000;

                font-family:
                    Tahoma,
                    Arial,
                    sans-serif;

                font-size:11px;
                font-weight:bold;

                cursor:pointer;

                pointer-events:
                    auto !important;
            }


            #kt11-settings-arrow {

                color:#888;

                transition:
                    transform .2s ease;
            }


            #kt11-settings-arrow.open {

                transform:
                    rotate(180deg);
            }


            #kt11-settings-panel {

                background:
                    linear-gradient(
                        135deg,
                        #222,
                        #171717
                    );

                border:
                    1px solid #3d3d3d;

                border-radius:8px;

                padding:9px;

                margin-bottom:9px;

                pointer-events:
                    auto !important;
            }


            #kt11-card-toggle {
                width:100%; display:flex; align-items:center; justify-content:space-between;
                background:#202020; border:1px solid #3d3d3d; border-radius:8px;
                padding:8px 10px; margin:0 0 6px; color:#ffd000;
                font: bold 11px Tahoma,Arial,sans-serif; cursor:pointer; pointer-events:auto !important;
            }
            #kt11-card-arrow { color:#888; transition:transform .2s ease; }
            #kt11-card-arrow.open { transform:rotate(180deg); }
            #kt11-card-panel { background:linear-gradient(135deg,#222,#171717); border:1px solid #3d3d3d;
                border-radius:8px; padding:9px; margin-bottom:7px; pointer-events:auto !important; }
            .kt11-card-label { display:block; margin:7px 0 4px; color:#c8c8c8; font:11px Tahoma,Arial,sans-serif; }
            .kt11-card-input { box-sizing:border-box; width:100%; min-width:0; padding:9px; border:1px solid #444;
                border-radius:6px; background:#111; color:#fff; font:13px Tahoma,Arial,sans-serif; outline:none; }
            .kt11-card-input:focus { border-color:#ffd000; }
            .kt11-card-expiry { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            #kt11-card-save { width:100%; margin-top:10px; padding:9px; border:0; border-radius:6px;
                background:#ffd000; color:#111; font:bold 12px Tahoma,Arial,sans-serif; cursor:pointer; }
            #kt11-card-message { margin-top:7px; font:11px/1.6 Tahoma,Arial,sans-serif; color:#70e08a; }
            .kt11-card-hint { display:block; margin-top:7px; color:#999; font:10px/1.7 Tahoma,Arial,sans-serif; }

            #kt11-customer-toggle {
                width:100%;
                display:flex;
                align-items:center;
                justify-content:space-between;
                background:#202020;
                border:1px solid #3d3d3d;
                border-radius:8px;
                padding:8px 10px;
                margin:0 0 6px;
                color:#ffd000;
                font-family:Tahoma,Arial,sans-serif;
                font-size:11px;
                font-weight:bold;
                cursor:pointer;
                pointer-events:auto !important;
            }

            #kt11-customer-arrow {
                color:#888;
                transition:transform .2s ease;
            }

            #kt11-customer-arrow.open {
                transform:rotate(180deg);
            }

            #kt11-customer-panel {
                background:linear-gradient(135deg,#222,#171717);
                border:1px solid #3d3d3d;
                border-radius:8px;
                padding:7px;
                margin-bottom:7px;
                pointer-events:auto !important;
            }

            .kt11-customer-row {
                display:flex;
                flex-direction:column;
                align-items:center;
                justify-content:center;
                text-align:center;
                gap:3px;
                padding:6px 4px;
                border:1px solid #333;
                border-radius:6px;
                background:rgba(255,255,255,.025);
                font-family:Tahoma,Arial,sans-serif;
                font-size:11px;
                min-width:0;
            }

            #kt11-customer-panel {
                display:grid;
                grid-template-columns:repeat(2,minmax(0,1fr));
                gap:6px;
            }

            .kt11-customer-row span {
                color:#b8b8b8;
                font-size:11px;
                line-height:1.5;
            }

            .kt11-customer-row strong {
                display:block;
                width:100%;
                color:#fff;
                font-size:13px;
                line-height:1.5;
                font-weight:600;
                overflow-wrap:anywhere;
            }

            #kt11-customer-refresh {
                grid-column:1 / -1;
                width:100%;
                margin-top:1px;
                padding:7px;
                border:1px solid #555;
                border-radius:6px;
                background:#292929;
                color:#ffd000;
                font:12px Tahoma,Arial,sans-serif;
                cursor:pointer;
                pointer-events:auto !important;
            }


            .kt11-setting-title {

                font-size:9px;
                color:#aaa;

                margin:
                    4px 0 7px;
            }


            .kt11-select {

                width:100%;

                height:31px;

                background:#303030;

                color:#fff;

                border:
                    1px solid #4b4b4b;

                border-radius:6px;

                padding:
                    0 7px;

                margin-bottom:6px;

                font-family:
                    Tahoma,
                    Arial,
                    sans-serif;

                font-size:12px;

                direction:ltr;

                cursor:pointer;

                pointer-events:
                    auto !important;
            }


            .kt11-select:focus {

                outline:
                    1px solid #ffd000;

                border-color:
                    #ffd000;
            }


            #kt11-save-settings {

                width:100%;

                height:32px;

                border:0;

                border-radius:6px;

                background:
                    linear-gradient(
                        135deg,
                        #ffd000,
                        #c79f00
                    );

                color:#111;

                font-family:
                    Tahoma,
                    Arial,
                    sans-serif;

                font-size:11px;

                font-weight:bold;

                cursor:pointer;

                pointer-events:
                    auto !important;

                transition:
                    transform .1s;
            }


            #kt11-save-settings:active {

                transform:
                    scale(.98);
            }


            #kt11-settings-message {

                text-align:center;

                font-size:9px;

                color:#32d74b;

                margin-top:6px;

                min-height:12px;
            }


            /* عنوان محصولات */

            #kt11-products-title {

                display:flex;

                align-items:center;
                justify-content:space-between;

                font-size:12px;
                font-weight:bold;

                color:#ccc;

                margin-bottom:6px;

                padding:
                    4px 2px;

                background:
                    transparent;
            }


            #kt11-products-title span {

                font-size:9px;

                color:#888;

                font-weight:normal;
            }


            /* باکس هر محصول */

            .kt11-product {

                background:
                    linear-gradient(
                        135deg,
                        #252525,
                        #181818
                    );

                border:
                    1px solid #3d3d3d;

                border-right:
                    4px solid #ffd000;

                border-radius:9px;

                padding:
                    8px 9px;

                margin-bottom:6px;

                box-shadow:
                    0 2px 8px
                    rgba(0,0,0,.20);
            }


            .kt11-product-top {

                display:flex;

                justify-content:space-between;

                align-items:center;
            }


            .kt11-product-code {

                font-size:14px;

                font-weight:bold;

                color:#fff;
            }


            .kt11-product-badge {

                font-size:9px;

                padding:
                    3px 7px;

                border-radius:20px;

                background:#444;

                color:#ddd;
            }


            .kt11-product-size {

                font-size:11px;

                margin-top:3px;

                color:#ddd;

                direction:ltr;

                text-align:right;
            }


            .kt11-product-quantity {

                font-size:10px;

                color:#aaa;

                margin-top:2px;
            }


            /* اطلاعات */

            #kt11-info {

                background:#1d1d1d;

                border-radius:8px;

                padding:
                    7px 9px;

                margin-top:8px;
            }


            .kt11-info-row {

                display:flex;

                justify-content:space-between;

                font-size:10px;

                padding:2px 0;

                color:#bbb;
            }


            .kt11-info-row b {
                color:#fff;
            }


            /* اتصال */

            #kt11-connection {

                margin-top:8px;

                background:
                    linear-gradient(
                        135deg,
                        #102617,
                        #142c1b
                    );

                border:
                    1px solid #235b32;

                border-right:
                    3px solid #32d74b;

                border-radius:8px;

                padding:
                    8px 9px;
            }


            #kt11-connection-top {

                display:flex;

                align-items:center;

                gap:8px;
            }


            #kt11-connection-icon {

                width:25px;
                height:25px;

                border-radius:50%;

                display:flex;

                align-items:center;
                justify-content:center;

                background:#1fa34a;

                color:#fff;

                font-size:15px;
                font-weight:bold;

                box-shadow:
                    0 0 9px
                    rgba(50,215,75,.35);
            }


            #kt11-connection-title {

                font-size:9px;

                color:#9fb9a5;

                margin-bottom:1px;
            }


            #kt11-connection-status {

                font-size:11px;

                color:#32d74b;

                font-weight:bold;
            }


            /* خرید و پشتیبانی */

            #kt11-support-box {

                position:relative;

                display:flex;

                align-items:center;

                gap:8px;

                margin-top:8px;

                padding:
                    8px 9px;

                border-radius:9px;

                background:
                    linear-gradient(
                        135deg,
                        #292929,
                        #171717
                    );

                border:
                    1px solid #3d3d3d;

                border-right:
                    3px solid #ffd000;

                overflow:hidden;

                box-shadow:
                    0 2px 10px
                    rgba(0,0,0,.22);

                cursor:pointer;

                pointer-events:
                    auto !important;

                transition:
                    transform .15s ease,
                    border-color .15s ease,
                    box-shadow .15s ease;
            }


            #kt11-support-box:hover {

                transform:
                    translateY(-1px);

                border-color:
                    #ffd000;

                box-shadow:
                    0 4px 14px
                    rgba(255,208,0,.18);
            }


            #kt11-support-box:active {

                transform:
                    scale(.98);
            }


            #kt11-support-box:focus-visible {

                outline:
                    2px solid #ffd000;

                outline-offset:2px;
            }


            #kt11-support-box::before {

                content:"";

                position:absolute;

                top:0;
                left:0;

                width:55px;
                height:100%;

                background:
                    linear-gradient(
                        90deg,
                        rgba(255,208,0,.10),
                        transparent
                    );

                pointer-events:none;
            }


            #kt11-support-icon {

                width:31px;
                height:31px;

                flex-shrink:0;

                display:flex;

                align-items:center;
                justify-content:center;

                border-radius:8px;

                background:
                    linear-gradient(
                        135deg,
                        #ffd000,
                        #c79f00
                    );

                font-size:16px;

                box-shadow:
                    0 2px 8px
                    rgba(255,208,0,.18);
            }


            #kt11-support-content {

                flex:1;
                min-width:0;
            }


            #kt11-support-title {

                font-size:11px;

                font-weight:bold;

                color:#fff;

                margin-bottom:1px;
            }


            #kt11-support-subtitle {

                font-size:8px;

                color:#888;

                margin-bottom:4px;
            }


            #kt11-support-id {

                display:inline-block;

                direction:ltr;

                font-family:
                    Arial,
                    sans-serif;

                font-size:10px;

                font-weight:bold;

                color:#ffd000;

                background:
                    rgba(255,208,0,.08);

                border:
                    1px solid
                    rgba(255,208,0,.20);

                border-radius:5px;

                padding:
                    2px 5px;
            }


            #kt11-support-arrow {

                font-size:19px;

                color:#666;

                transform:
                    rotate(180deg);
            }

        `;


        if (
            !document.getElementById(
                'kt11-dashboard-style'
            )
        ) {

            document.head.appendChild(
                style
            );

        }


        document.body.appendChild(
            panel
        );


        /* =====================================================
           دکمه ON / OFF
           ===================================================== */

        const powerButton =
            document.getElementById(
                'kt11-power-button'
            );


        if (powerButton) {

            powerButton.addEventListener(
                'click',
                toggleBot
            );

        }


        const compactToggle = panel.querySelector('#kt11-compact-toggle');
        if (compactToggle && !compactToggle.dataset.kt11Bound) {
            compactToggle.dataset.kt11Bound = '1';
            compactToggle.addEventListener('click', (event) => {
                // جلوگیری از رسیدن کلیک به listenerهای خود سایت و رفرش ناخواسته
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                const dashboard = document.getElementById('kt11-dashboard');
                if (!dashboard) return;
                const compact = dashboard.classList.toggle('kt11-compact');
                compactToggle.textContent = '□';
                compactToggle.title = compact ? 'باز کردن پنل' : 'جمع کردن پنل';
                compactToggle.setAttribute('aria-expanded', String(!compact));
            }, true);
        }

        /* =====================================================
           باز و بسته کردن تنظیمات
           ===================================================== */

        const settingsToggle =
            document.getElementById(
                'kt11-settings-toggle'
            );


        const settingsPanel =
            document.getElementById(
                'kt11-settings-panel'
            );


        const settingsArrow =
            document.getElementById(
                'kt11-settings-arrow'
            );


        if (
            settingsToggle &&
            settingsPanel
        ) {

            settingsToggle.addEventListener(
                'click',
                () => {

                    const isOpen =
                        settingsPanel.style.display !==
                        'none';


                    settingsPanel.style.display =
                        isOpen
                            ? 'none'
                            : 'block';


                    if (settingsArrow) {

                        settingsArrow.classList.toggle(
                            'open',
                            !isOpen
                        );

                    }

                }
            );

        }


        /* =====================================================
           باز و بسته کردن اطلاعات مشتری
           ===================================================== */
        const customerToggle = document.getElementById('kt11-customer-toggle');
        const customerPanel = document.getElementById('kt11-customer-panel');
        const customerArrow = document.getElementById('kt11-customer-arrow');
        const customerRefresh = document.getElementById('kt11-customer-refresh');

        if (customerToggle && customerPanel) {
            customerToggle.addEventListener('click', () => {
                const isOpen = customerPanel.style.display !== 'none';
                customerPanel.style.display = isOpen ? 'none' : 'block';
                customerToggle.setAttribute('aria-expanded', String(!isOpen));
                if (customerArrow) customerArrow.classList.toggle('open', !isOpen);
                if (!isOpen) loadCustomerInfo();
            });
        }

        if (customerRefresh) customerRefresh.addEventListener('click', loadCustomerInfo);
        // اطلاعات مشتری را حتی اگر بخش آن باز نشود، چند بار برای متن پرداخت بررسی کن.
        loadCustomerInfo();
        let customerCaptureAttempts = 0;
        const customerCaptureTimer = setInterval(() => {
            loadCustomerInfo();
            customerCaptureAttempts++;
            if (customerCaptureAttempts >= 20) clearInterval(customerCaptureTimer);
        }, 1500);

        /* =====================================================
           اطلاعات کارت و تحویل موقت CVV2 به درگاه
           ===================================================== */
        const cardToggle = document.getElementById('kt11-card-toggle');
        const cardPanel = document.getElementById('kt11-card-panel');
        const cardArrow = document.getElementById('kt11-card-arrow');
        const cardSave = document.getElementById('kt11-card-save');
        const cardMessage = document.getElementById('kt11-card-message');

        if (cardToggle && cardPanel) {
            cardToggle.addEventListener('click', async () => {
                const isOpen = cardPanel.style.display !== 'none';
                cardPanel.style.display = isOpen ? 'none' : 'block';
                cardToggle.setAttribute('aria-expanded', String(!isOpen));
                if (cardArrow) cardArrow.classList.toggle('open', !isOpen);
                if (!isOpen) {
                    try {
                        const saved = await GM_getValue(KT11_CARD_INFO_KEY, {}) || {};
                        document.getElementById('kt11-card-number').value = saved.number || '';
                        document.getElementById('kt11-card-month').value = saved.month || '';
                        document.getElementById('kt11-card-year').value = saved.year || '';
                        // CVV2 عمداً از حافظه دائمی بازخوانی نمی‌شود.
                    } catch (_) {}
                }
            });
        }

        if (cardSave) cardSave.addEventListener('click', async () => {
            const number = normalizeCardDigits(document.getElementById('kt11-card-number')?.value);
            const cvv = normalizeCardDigits(document.getElementById('kt11-card-cvv')?.value);
            const month = normalizeCardDigits(document.getElementById('kt11-card-month')?.value);
            const year = normalizeCardDigits(document.getElementById('kt11-card-year')?.value);
            if (number.length < 13 || number.length > 19) { cardMessage.textContent = 'شماره کارت را بررسی کن.'; cardMessage.style.color = '#ff7777'; return; }
            if (!/^(0?[1-9]|1[0-2])$/.test(month)) { cardMessage.textContent = 'ماه انقضا باید بین ۱ تا ۱۲ باشد.'; cardMessage.style.color = '#ff7777'; return; }
            if (!/^\d{2}$/.test(year)) { cardMessage.textContent = 'سال انقضا را با ۲ رقم وارد کن.'; cardMessage.style.color = '#ff7777'; return; }
            if (!/^\d{3,4}$/.test(cvv)) { cardMessage.textContent = 'CVV2 باید ۳ یا ۴ رقم باشد.'; cardMessage.style.color = '#ff7777'; return; }
            try {
                await GM_setValue(KT11_CARD_INFO_KEY, { number, month: String(Number(month)), year: year.slice(-2), savedAt: Date.now() });
                await GM_setValue(KT11_CARD_CVV_TEMP_KEY, cvv);
                await GM_setValue(KT11_CARD_CVV_TIME_KEY, Date.now());
                document.getElementById('kt11-card-cvv').value = '';
                cardMessage.style.color = '#70e08a';
                cardMessage.textContent = 'تنظیمات انجام شد';
            } catch (_) { cardMessage.style.color = '#ff7777'; cardMessage.textContent = 'ذخیره اطلاعات کارت ناموفق بود؛ دسترسی Tampermonkey را بررسی کن.'; }
        });


        /* =====================================================
           ذخیره تنظیمات
           ===================================================== */

        const saveButton =
            document.getElementById(
                'kt11-save-settings'
            );


        if (saveButton) {

            saveButton.addEventListener(
                'click',
                saveUserSettings
            );

        }


        /* =====================================================
           کلیک روی پشتیبانی
           ===================================================== */

        const supportBox =
            document.getElementById(
                'kt11-support-box'
            );


        if (supportBox) {

            supportBox.addEventListener(
                'click',
                () => {

                    window.open(
                        TELEGRAM_URL,
                        '_blank',
                        'noopener,noreferrer'
                    );

                }
            );


            supportBox.addEventListener(
                'keydown',
                event => {

                    if (
                        event.key === 'Enter' ||
                        event.key === ' '
                    ) {

                        event.preventDefault();

                        window.open(
                            TELEGRAM_URL,
                            '_blank',
                            'noopener,noreferrer'
                        );

                    }

                }
            );

        }


        updatePowerUI();

    }


    /* =========================================================
       خواندن و نمایش اطلاعات مشتری از کارت اطلاعات سایت
       ========================================================= */
    function readCustomerText(selector) {
        const element = document.querySelector(selector);
        return element ? (element.innerText || element.textContent || '').trim() : '';
    }

    // قالب جدید سایت: .info-card و مقادیر داخل dt/dd
    function readInfoCardValue(sectionSelector, label) {
        const section = document.querySelector(sectionSelector);
        if (!section) return '';
        const rows = section.querySelectorAll('dl > div');
        for (const row of rows) {
            const dt = row.querySelector('dt');
            const dd = row.querySelector('dd');
            if (!dt || !dd) continue;
            const key = (dt.innerText || dt.textContent || '').replace(/\s+/g, ' ').trim();
            if (key === label) {
                // فقط متن خود dd خوانده می‌شود؛ لینک/آیکون ویرایش در خروجی دخالت نمی‌کند.
                const clone = dd.cloneNode(true);
                clone.querySelectorAll('a, button, i, svg').forEach(node => node.remove());
                return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
            }
        }
        return '';
    }

    function loadCustomerInfo() {
        const firstName = readInfoCardValue('.info-card .info-section[aria-labelledby="info-personal"]', 'نام');
        const lastName = readInfoCardValue('.info-card .info-section[aria-labelledby="info-personal"]', 'نام خانوادگی');
        const fields = {
            name: [firstName, lastName].filter(Boolean).join(' ').trim() || (
                readCustomerText('.card .col-md-4 .list li:nth-child(1) span') +
                (readCustomerText('.card .col-md-4 .list li:nth-child(2) span') ?
                    ' ' + readCustomerText('.card .col-md-4 .list li:nth-child(2) span') : '')
            ).trim(),
            nationalCode: readInfoCardValue('.info-card .info-section[aria-labelledby="info-personal"]', 'کد ملی') ||
                readCustomerText('.card .col-md-4 .list li:nth-child(3) span'),
            phone: readInfoCardValue('.info-card .info-section[aria-labelledby="info-personal"]', 'موبایل') ||
                readCustomerText('.card .col-md-4 .list li:nth-child(4) span'),
            car: readInfoCardValue('.info-card .info-section[aria-labelledby="info-car"]', 'خودرو') ||
                readCustomerText('.card .col-md-8 .list li:nth-child(1) span')
        };

        try {
            // داده خالی را جایگزین اطلاعات معتبر ذخیره‌شده نکن.
            if (typeof GM_setValue === 'function' && Object.values(fields).some(value => String(value || '').trim())) {
                Promise.resolve(GM_setValue(KT11_CUSTOMER_INFO_KEY, {
                    name: fields.name || '',
                    nationalCode: fields.nationalCode || '',
                    phone: fields.phone || '',
                    car: fields.car || '',
                    savedAt: Date.now()
                })).catch(() => {});
            }
        } catch (_) {}

        const values = {
            'kt11-customer-name': fields.name,
            'kt11-customer-national-code': fields.nationalCode,
            'kt11-customer-phone': fields.phone,
            'kt11-customer-car': fields.car
        };
        let found = false;
        Object.entries(values).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (!element) return;
            element.textContent = value || 'در این صفحه پیدا نشد';
            if (value) found = true;
        });

        // نمایش اطلاعات بدون پیام اضافی؛ در صورت نبود داده، متن جایگزین در هر فیلد دیده می‌شود.
    }


    /* =========================================================
       ذخیره تنظیمات کاربر
       ========================================================= */

    function saveUserSettings() {

        const select1 =
            document.getElementById(
                'kt11-product-select-1'
            );

        const select2 =
            document.getElementById(
                'kt11-product-select-2'
            );

        const totalQuantity =
            document.getElementById('kt11-total-quantity');


        if (
            !select1 ||
            !select2 ||
            !totalQuantity
        ) {
            return;
        }


        const size1 = select1.value;
        const size2 = select2.value;
        const selectedQuantity = Number(totalQuantity.value);
        const code1 = (productOptions.find(option => option.size === size1) || {}).code;
        const code2 = (productOptions.find(option => option.size === size2) || {}).code;

        if (![1, 2].includes(selectedQuantity)) {
            showSettingsMessage('❌ تعداد خرید فقط می‌تواند ۱ یا ۲ حلقه باشد.', true);
            return;
        }


        const newProduct1 = {

            code:
                code1,

            size:
                size1,

            quantity:
                selectedQuantity

        };


        const newProduct2 = {

            code:
                code2,

            size:
                size2,

            quantity:
                selectedQuantity

        };


        if (
            !validateSingleProduct(
                newProduct1
            ) ||
            !validateSingleProduct(
                newProduct2
            )
        ) {

            showSettingsMessage(
                '❌ تنظیمات انتخاب‌شده صحیح نیست.',
                true
            );

            return;
        }


        /* اگر خرید در حال انجام است،
           تنظیمات جدید روی خرید جاری اعمال نشود */

        if (purchaseStarted) {

            showSettingsMessage(
                '⚠️ خرید در حال انجام است؛ بعد از پایان خرید تغییر دهید.',
                true
            );

            return;
        }


        Object.assign(product1, newProduct1, { name: newProduct1.code });
        Object.assign(product2, newProduct2, { name: newProduct2.code });


        settings = {
            quantity: selectedQuantity,
            product1: { code: product1.code, size: product1.size, quantity: selectedQuantity },
            product2: { code: product2.code, size: product2.size, quantity: selectedQuantity }
        };


        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(settings)
        );


        rebuildProductStates();


        updateProductCards();


        showSettingsMessage(
            '✓ تنظیمات با موفقیت ذخیره شد.',
            false
        );


        updateDashboardStatus(
            '⚙️',
            'تنظیمات خرید با موفقیت تغییر کرد.'
        );

    }


    function validateSingleProduct(
        product
    ) {

        if (
            !product ||
            typeof product.code !== 'string' ||
            typeof product.size !== 'string'
        ) {

            return false;

        }


        const validOption = productOptions.some(option =>
            option.code === product.code && option.size === product.size
        );

        if (!validOption) {
            return false;
        }


        if (
            !Number.isInteger(
                product.quantity
            ) ||
            product.quantity < 1 ||
            product.quantity > 2
        ) {

            return false;

        }


        return true;

    }


    function showSettingsMessage(
        message,
        isError
    ) {

        const element =
            document.getElementById(
                'kt11-settings-message'
            );


        if (!element) {
            return;
        }


        element.textContent =
            message;


        element.style.color =
            isError
                ? '#ff5555'
                : '#32d74b';


        setTimeout(() => {

            if (
                element.textContent ===
                message
            ) {

                element.textContent =
                    '';

            }

        }, 3500);

    }


    /* =========================================================
       بروزرسانی نمایش محصولات
       ========================================================= */

    function updateProductCards() {

        const container =
            document.getElementById(
                'kt11-products'
            );


        if (!container) {
            return;
        }


        container.innerHTML =
            products.map(product => `

                <div
                    class="kt11-product"
                    id="kt11-product-${productKey(product)}"
                >

                    <div class="kt11-product-top">

                        <span class="kt11-product-code">
                            ${product.code}
                        </span>

                        <span
                            class="kt11-product-badge"
                            id="kt11-badge-${productKey(product)}"
                        >
                            در انتظار
                        </span>

                    </div>

                    <div class="kt11-product-size">
                        سایز: ${product.size}
                    </div>

                    <div class="kt11-product-quantity">
                        تعداد درخواستی:
                        <b>${product.quantity}</b>
                        حلقه
                    </div>

                </div>

            `).join('');

    }


    /* =========================================================
       ON / OFF
       ========================================================= */

    function toggleBot() {
        if (purchaseStarted) {
            updateDashboardStatus('⚠️', 'خرید در حال انجام است؛ تغییر وضعیت فعلاً انجام نشد.');
            return;
        }

        botEnabled = !botEnabled;

        // با هر تغییر وضعیت ON/OFF، شمارنده از صفر شروع می‌شود.
        checkCount = 0;
        try {
            sessionStorage.setItem(CHECK_COUNT_STORAGE_KEY, '0');
        } catch (_) {}

        saveBotEnabledState();
        updatePowerUI();
        updateInfo();

        if (botEnabled) {
            botLocked = false;
            updateDashboardStatus('🟢', 'ربات روشن شد؛ تشخیص سریع موجودی فعال است.');
            startEngine();
        } else {
            stopEngine();
            updateDashboardStatus('🔴', 'ربات خاموش است — بررسی متوقف شد.');
            updateInfo();
        }
    }


    function updatePowerUI() {

        const button =
            document.getElementById(
                'kt11-power-button'
            );

        const status =
            document.getElementById(
                'kt11-power-status'
            );

        if (!button || !status) {
            return;
        }


        if (botEnabled) {

            button.textContent =
                'ON';

            button.className =
                'on';

            status.textContent =
                '🟢 روشن';

            status.style.color =
                '#32d74b';

        } else {

            button.textContent =
                'OFF';

            button.className =
                'off';

            status.textContent =
                '🔴 خاموش';

            status.style.color =
                '#ff5555';

        }

    }


    /* =========================================================
       وضعیت اصلی
       ========================================================= */

    function updateDashboardStatus(
        icon,
        text
    ) {

        createDashboard();


        const iconElement =
            document.getElementById(
                'kt11-main-icon'
            );

        const textElement =
            document.getElementById(
                'kt11-main-text'
            );


        if (iconElement) {

            iconElement.textContent =
                icon;


            if (icon === '⏳') {

                iconElement.classList.add(
                    'kt11-hourglass'
                );

            } else {

                iconElement.classList.remove(
                    'kt11-hourglass'
                );

            }

        }


        if (textElement) {

            textElement.textContent =
                text;

        }

    }


    /* =========================================================
       وضعیت محصولات
       ========================================================= */

    function updateProductStatus(
        product,
        status,
        text
    ) {

        productStates[
            productKey(product)
        ] = {

            status,
            text

        };


        const badge =
            document.getElementById(
                `kt11-badge-${productKey(product)}`
            );


        if (!badge) {
            return;
        }


        badge.textContent =
            text;


        if (
            status === 'available'
        ) {

            badge.style.background =
                '#16883a';

            badge.style.color =
                '#fff';

        } else if (
            status === 'error'
        ) {

            badge.style.background =
                '#a52a2a';

            badge.style.color =
                '#fff';

        } else if (
            status === 'buying'
        ) {

            badge.style.background =
                '#b88600';

            badge.style.color =
                '#fff';

        } else {

            badge.style.background =
                '#444';

            badge.style.color =
                '#ddd';

        }

    }


    /* =========================================================
       اطلاعات پنل
       ========================================================= */

    function updateInfo() {

        const lastCheck =
            document.getElementById(
                'kt11-last-check'
            );

        const count =
            document.getElementById(
                'kt11-check-count'
            );


        if (lastCheck) {
            lastCheck.textContent = lastCheckAt
                ? new Date(lastCheckAt).toLocaleTimeString('fa-IR')
                : '—';
        }


        if (count) {

            count.textContent =
                checkCount;

        }

    }


    /* =========================================================
       موتور سریع KT10.1 + پنل KT11
       ========================================================= */
    function stopEngine() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = null;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        if (fastObserver) fastObserver.disconnect();
        fastObserver = null;
        if (observerCheckTimer) clearTimeout(observerCheckTimer);
        observerCheckTimer = null;
        observerStarted = false;
    }

    function validateProducts() {
        return products.every(validateSingleProduct);
    }

    function isBadGatewayText(text) {
        if (!text) return false;
        const value = String(text).toLowerCase().replace(/\s+/g, ' ');
        // عدد 502 به‌تنهایی ممکن است در متن عادی صفحه یا پنل دیده شود؛
        // فقط عبارت مشخص خطای درگاه را خطای واقعی صفحه حساب کن.
        return value.includes('502 bad gateway') || value.includes('bad gateway');
    }

    function recoverFrom502(source = 'unknown') {
        if (!botEnabled || botLocked) return;
        const now = Date.now();
        if (gatewayRecoveryRunning || now - lastGatewayRecovery < BAD_GATEWAY_COOLDOWN) return;

        // تغییر سایت: در خطای 502 صفحه را خودکار رفرش نکن؛ این کار می‌تواند
        // چرخه رفرش ایجاد کند و باعث محدودیت حساب شود. فقط هشدار بده و اجازه بده
        // کاربر وضعیت سایت را بررسی کند یا بعداً دستی دوباره تلاش کند.
        gatewayRecoveryRunning = true;
        lastGatewayRecovery = now;
        updateDashboardStatus('⚠️', `خطای 502 از ${source}؛ رفرش خودکار متوقف شد. وضعیت سایت را بررسی کنید.`);
        console.warn('[KavirTire] 502 detected; automatic page reload intentionally disabled.');
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadTimer = null;
            gatewayRecoveryRunning = false;
        }, 5000);
    }

    function checkFor502Page() {
        const now = Date.now();
        if (now - last502PageCheck < 1500) return false;
        last502PageCheck = now;
        // متن پنل خود ربات را از بررسی حذف کن تا هشدار قبلی خودش
        // باعث تشخیص اشتباه 502 در بررسی بعدی نشود.
        let bodyText = '';
        if (document.body) {
            const pageCopy = document.body.cloneNode(true);
            const ownPanel = pageCopy.querySelector('#kt11-dashboard');
            if (ownPanel) ownPanel.remove();
            bodyText = pageCopy.innerText || pageCopy.textContent || '';
        }
        if (isBadGatewayText(bodyText)) {
            recoverFrom502('page');
            return true;
        }
        return false;
    }

    function installFetchMonitor() {
        if (typeof window.fetch !== 'function' || window.fetch.__kavirMonitored) return;
        const originalFetch = window.fetch;
        const monitoredFetch = async function (...args) {
            try {
                const response = await originalFetch.apply(this, args);
                if (response && response.status === 502) recoverFrom502('fetch');
                return response;
            } catch (error) {
                console.warn('[KavirTire] Fetch error:', error);
                throw error;
            }
        };
        monitoredFetch.__kavirMonitored = true;
        window.fetch = monitoredFetch;
    }

    function installXHRMonitor() {
        if (XMLHttpRequest.prototype.send.__kavirMonitored) return;
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._kavirUrl = url;
            return originalOpen.call(this, method, url, ...rest);
        };
        const monitoredSend = function (...args) {
            this.addEventListener('load', function () {
                if (this.status === 502) recoverFrom502('XMLHttpRequest');
            });
            this.addEventListener('error', function () {
                console.warn('[KavirTire] XHR network error');
            });
            return originalSend.apply(this, args);
        };
        monitoredSend.__kavirMonitored = true;
        XMLHttpRequest.prototype.send = monitoredSend;
    }

    // یکسان‌سازی سایزها: 205/50/16 و 205/50R16 به یک قالب تبدیل می‌شوند.
    // ارقام فارسی و عربی نیز برای تطبیق دقیق به ارقام انگلیسی تبدیل می‌شوند.
    function normalizeSize(value) {
        return String(value || '')
            .replace(/[۰-۹]/g, digit => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))
            .replace(/[٠-٩]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
            .replace(/(\d{3})\s*[\/.-]\s*(\d{2})\s*R?\s*[\/.-]?\s*(\d{2})/gi, '$1/$2/$3')
            .replace(/\s+/g, '')
            .toUpperCase();
    }

    function findProducts() {
        const cards = Array.from(document.querySelectorAll('.product'));
        const found = [];
        const seenCards = new Set();

        // ترتیب بررسی بر اساس اولویت پنل است: اولویت اول، سپس اولویت دوم.
        for (const selectedProduct of products) {
            for (const card of cards) {
                if (seenCards.has(card)) continue;
                const title = card.querySelector('.title');
                if (!title) continue;
                if (!normalizeSize(card.textContent).includes(normalizeSize(selectedProduct.size))) continue;

                seenCards.add(card);
                const actualTitle = title.textContent.trim();
                const actualCodeMatch = actualTitle.match(/\bKB\s*\d+\b/i);
                found.push({
                    card,
                    product: {
                        ...selectedProduct,
                        // گزارش کد واقعی محصول روی سایت؛ تطبیق بر اساس سایز انتخابی است.
                        name: actualCodeMatch ? actualCodeMatch[0].replace(/\s+/g, '').toUpperCase() : actualTitle
                    }
                });
            }
        }

        return found;
    }

    function isVisible(element) {
        if (!element || element.hidden || element.classList.contains('d-none')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    function tryAddProducts() {
        if (!botEnabled || botLocked) return false;
        if (checkFor502Page()) return false;

        const items = findProducts();
        if (!items.length) return false;

        let clicked = false;
        const justAdded = [];
        const clickedSizes = new Set();

        for (const item of items) {
            const { card, product } = item;
            const normalizedProductSize = normalizeSize(product.size);
            if (clickedSizes.has(normalizedProductSize)) continue;
            const unavailable = card.querySelector(
                '.control.unavailable, .product-unavailable'
            );

            if (unavailable && isVisible(unavailable)) {
                updateProductStatus(product, 'waiting', 'در انتظار موجودی');
                continue;
            }

            // دکمه موجودی در صفحه فروش با کلاس product-add-button و wire:click="add" نمایش داده می‌شود.
            const basketButton = card.querySelector(
                'button.product-add-button, button.btn-basket, .product-add-button, .btn-basket'
            );

            if (
                !basketButton ||
                basketButton.disabled ||
                basketButton.getAttribute('aria-disabled') === 'true' ||
                basketButton.dataset.kavirClicked === '1' ||
                !isVisible(basketButton)
            ) continue;

            basketButton.dataset.kavirClicked = '1';
            clickedSizes.add(normalizedProductSize);
            clicked = true;
            justAdded.push(product);
            updateProductStatus(product, 'available', 'موجود');
            updateDashboardStatus(
                '🚀',
                `لاستیک موجود شد: ${product.name || product.code} ${product.size}`
            );
            console.log(
                '[KavirTire] Product found:',
                product.name || product.code,
                product.size,
                '| add action:',
                basketButton.getAttribute('wire:click')
            );
            try { sessionStorage.removeItem(PAYMENT_FLOW_KEY); } catch (_) {}
            basketButton.click();
            // هر سفارش فقط شامل یک محصول/سایز باشد؛ تعداد حلقه در سبد روی ۱ یا ۲ تنظیم می‌شود.
            break;
        }

        if (clicked) {
            botLocked = true;
            purchaseStarted = true;
            addedProducts = [...new Set(justAdded)];
            if (reloadTimer) clearTimeout(reloadTimer);
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = null;
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            if (fastObserver) fastObserver.disconnect();
            fastObserver = null;
            console.log('[KavirTire] Product add requested - waiting for payment page');
            // سایت ممکن است صفحه را کامل جابه‌جا کند؛ مراحل پرداخت روی /esale/payment اجرا می‌شوند.
            if (location.pathname === '/esale/payment') {
                setTimeout(startPaymentFlow, 300);
            }
            return true;
        }

        return false;
    }

    function startFastObserver() {
        if (observerStarted || !document.body) return;
        observerStarted = true;
        fastObserver = new MutationObserver(() => {
            if (observerCheckTimer || botLocked || !botEnabled) return;
            // جهش‌های DOM متعدد در یک بازه کوتاه را به یک بررسی تبدیل کن تا تب قفل نشود.
            observerCheckTimer = setTimeout(() => {
                observerCheckTimer = null;
                if (!botLocked && botEnabled) tryAddProducts();
            }, 180);
        });
        fastObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'disabled', 'aria-disabled']
        });
        console.log('[KavirTire] Fast observer started');
    }

    function startFastPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!botEnabled || botLocked) return;
            if (Date.now() - lastInfoUpdate > 1000) {
                lastInfoUpdate = Date.now();
                updateInfo();
            }
            tryAddProducts();
        }, FAST_CHECK_INTERVAL);
    }

    function clickAvailabilityRefresh() {
        if (!botEnabled || botLocked) return;

        const refreshButton = document.querySelector('[data-refresh-availability], .refresh-availability');
        if (!refreshButton || !isVisible(refreshButton) || refreshButton.disabled ||
            refreshButton.getAttribute('aria-disabled') === 'true') {
            // اگر سایت هنوز دکمه را آزاد نکرده، نوبت را از دست نده؛ زود دوباره بررسی کن.
            // refreshTimer در این نسخه timeout است، پس فقط یک تلاش مجدد هم‌زمان خواهیم داشت.
            console.log('[KavirTire] دکمه بروزرسانی هنوز آماده نیست؛ بررسی مجدد تا 150ms دیگر.');
            refreshTimer = setTimeout(clickAvailabilityRefresh, 150);
            return;
        }

        refreshButton.click();
        // هر کلیک واقعی روی دکمه استعلام = یک استعلام؛ تیک‌های polling در شمارنده حساب نمی‌شوند.
        checkCount++;
        lastCheckAt = Date.now();
        try {
            sessionStorage.setItem(CHECK_COUNT_STORAGE_KEY, String(checkCount));
            sessionStorage.setItem(LAST_CHECK_AT_STORAGE_KEY, String(lastCheckAt));
        } catch (_) {}
        updateInfo();
        console.log('[KavirTire] دکمه «بروزرسانی موجودی» کلیک شد؛ تعداد استعلام:', checkCount, new Date().toLocaleTimeString());

        // بعد از شروع بروزرسانی، یک بررسی اضافه انجام بده؛ بررسی سریع و MutationObserver هم فعال می‌مانند.
        setTimeout(() => {
            if (botEnabled && !botLocked) tryAddProducts();
        }, 150);

        // فاصله تعریف‌شده از کلیک واقعی حساب می‌شود، نه از نوبت تایمر قبلی؛
        // اگر دکمه موقتاً غیرفعال بود، بالا هر 150ms تا آماده‌شدن بررسی می‌شود.
        refreshTimer = setTimeout(clickAvailabilityRefresh, REFRESH_INTERVAL);
    }

    function startEngine() {
        if (!botEnabled || purchaseStarted || !validateProducts()) return;
        installFetchMonitor();
        installXHRMonitor();
        startFastObserver();
        startFastPolling();
        tryAddProducts();

        if (refreshTimer) clearTimeout(refreshTimer);
        // اولین استعلام بلافاصله آغاز می‌شود؛ دفعات بعدی با فاصله معمول ادامه پیدا می‌کنند.
        refreshTimer = null;
        clickAvailabilityRefresh();
    }

    /* =========================================================
       ادامه خودکار خرید در صفحه پرداخت
       این صفحه ممکن است پس از افزودن به سبد، با بارگذاری کامل باز شود؛
       بنابراین مراحل تعداد، درگاه و ادامه خرید باید از همین مسیر اجرا شوند.
       ========================================================= */

    let paymentFlowStarted = false;
    const PAYMENT_FLOW_KEY = 'KT11_PAYMENT_FLOW_STARTED';

    function startPaymentFlow() {
        if (paymentFlowStarted || !botEnabled) return;
        paymentFlowStarted = true;

        updateDashboardStatus('🛒', 'صفحه پرداخت باز شد؛ در حال تنظیم تعداد حلقه‌ها...');
        setTimeout(setPaymentQuantity, 500);
    }

    function setPaymentQuantity() {
        if (!botEnabled) return;

        const desiredQuantity = Number(settings.quantity) === 1 ? 1 : 2;

        if (desiredQuantity === 1) {
            // تعداد پیش‌فرض سایت ۲ است؛ برای سفارش یک‌حلقه‌ای منفی را فقط یک بار می‌زنیم.
            const minusButton = [...document.querySelectorAll(
                'button[wire\\:click="minus()"]'
            )].find(button => isVisible(button) && !button.disabled);

            if (!minusButton) {
                setTimeout(setPaymentQuantity, STEP_INTERVAL);
                return;
            }

            if (sessionStorage.getItem(PAYMENT_FLOW_KEY) !== 'minus-clicked') {
                sessionStorage.setItem(PAYMENT_FLOW_KEY, 'minus-clicked');
                minusButton.click();
                updateDashboardStatus('🛒', 'درخواست کاهش تعداد به ۱ حلقه ارسال شد');
                setTimeout(selectPaymentGateway, 700);
                return;
            }
        }

        updateDashboardStatus('🛒', `تعداد سفارش: ${desiredQuantity} حلقه`);
        setTimeout(selectPaymentGateway, 250);
    }

    function selectPaymentGateway() {
        if (!botEnabled) return;

        const gateway = [...document.querySelectorAll('.method')]
            .find(element => element.getAttribute('wire:click') === "setGateway('refahk')");

        if (!gateway) {
            setTimeout(selectPaymentGateway, STEP_INTERVAL);
            return;
        }

        if (!gateway.classList.contains('active')) {
            gateway.click();
            updateDashboardStatus('💳', 'درخواست انتخاب درگاه رفاه ارسال شد');
            setTimeout(confirmPaymentStep, 500);
            return;
        }

        setTimeout(confirmPaymentStep, 200);
    }

    function confirmPaymentStep() {
        if (!botEnabled) return;

        const gateway = [...document.querySelectorAll('.method')]
            .find(element => element.getAttribute('wire:click') === "setGateway('refahk')");

        // اگر درگاه هنوز فعال نشده، فرصت بدهیم تغییر Livewire اعمال شود.
        if (!gateway || !gateway.classList.contains('active')) {
            setTimeout(selectPaymentGateway, STEP_INTERVAL);
            return;
        }

        // در نسخه جدید سایت، دکمه تأیید از <a> به <button> تغییر کرده است.
        // انتخاب بر اساس wire:click انجام می‌شود تا به نوع تگ وابسته نباشد.
        const nextButton = [...document.querySelectorAll('[wire\\:click]')].find(element =>
            element.getAttribute('wire:click') === 'next()' &&
            (element.matches('button') || element.classList.contains('btn-pay')) &&
            isVisible(element)
        );

        // عناصر wire:loading در HTML همیشه وجود دارند؛ وجودشان به‌تنهایی
        // به معنی در حال بارگذاری بودن نیست. فقط وضعیت واقعی disabled را بررسی کن.
        if (!nextButton || nextButton.disabled || nextButton.hasAttribute('disabled')) {
            setTimeout(confirmPaymentStep, STEP_INTERVAL);
            return;
        }

        updateDashboardStatus('➡️', 'درگاه رفاه انتخاب شد؛ در حال تأیید و پرداخت...');
        // کلیک عادی DOM باعث اجرای handler ثبت‌شده Livewire روی دکمه می‌شود.
        nextButton.click();
        // فقط پس از ارسال کلیک، برای جلوگیری از چندبار ارسال، ربات متوقف می‌شود.
        botEnabled = false;
        saveBotEnabledState();
        updatePowerUI();
        if (refreshTimer) clearTimeout(refreshTimer);
        if (pollTimer) clearInterval(pollTimer);
    }

    /* =========================================================
       شروع و مراقبت از پنل
       ========================================================= */

    if (!validateProducts()) {
        console.error('[KavirTire] تنظیمات محصولات صحیح نیست.');
        return;
    }

    createDashboard();

    const dashboardObserver = new MutationObserver(() => {
        if (!document.getElementById('kt11-dashboard')) createDashboard();
    });
    if (document.body) dashboardObserver.observe(document.body, { childList: true });

    if (location.pathname === '/esale/products') {
        setTimeout(() => {
            if (!botEnabled) return;
            updateDashboardStatus('🟢', 'ربات فعال است؛ تشخیص سریع موجودی شروع شد.');
            startEngine();
        }, 300);
    } else if (location.pathname === '/esale/payment') {
        setTimeout(() => {
            if (!botEnabled) return;
            startPaymentFlow();
        }, 300);
    } else {
        updateDashboardStatus('🤖', 'برای شروع، وارد صفحه خرید لاستیک شوید.');
    }

    // تغییر مسیرهای SPA را هم مدیریت می‌کنیم تا ورود به صفحه خرید نیاز به رفرش صفحه نداشته باشد.
    let lastObservedPath = location.pathname;
    setInterval(() => {
        if (location.hostname !== 'kavirtire.ir') return;
        const currentPath = location.pathname;

        if (currentPath !== lastObservedPath) {
            lastObservedPath = currentPath;
            if (currentPath === '/esale/products') {
                if (botEnabled) {
                    updateDashboardStatus('🟢', 'وارد صفحه خرید شد؛ استعلام موجودی فوراً شروع می‌شود.');
                    startEngine();
                } else {
                    stopEngine();
                    updateDashboardStatus('🔴', 'ربات خاموش است — برای شروع ON را بزنید.');
                }
            } else if (currentPath === '/esale/payment') {
                stopEngine();
                if (botEnabled) startPaymentFlow();
            } else {
                stopEngine();
            }
        }

        if (currentPath === '/esale/payment' && !paymentFlowStarted && botEnabled) {
            startPaymentFlow();
        }
    }, 250);

})();

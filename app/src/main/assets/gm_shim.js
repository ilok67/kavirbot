if (typeof KTNative === 'undefined') return;
window.GM_getValue = function (k, d) {
    try {
        var raw = KTNative.get(String(k));
        if (raw === null || raw === undefined) return d;
        return JSON.parse(raw);
    } catch (e) { return d; }
};
window.GM_setValue = function (k, v) {
    try { KTNative.set(String(k), JSON.stringify(v === undefined ? null : v)); } catch (e) {}
};
(function () {
    if (location.hostname !== 'kavirtire.ir') return;
    var RETURN_DELAY = 4000, MAX_RETURNS = 200;
    try {
        var p = location.pathname.replace(/\/+$/, '');
        if (p.indexOf('/esale/payment') === 0) sessionStorage.setItem('kb_paid', '1');
        if (p !== '/esale') return;
        if (localStorage.getItem('KT11_BOT_ENABLED') !== '1') return;
        if (sessionStorage.getItem('kb_paid') === '1') return;
        var n = Number(sessionStorage.getItem('kb_returns') || 0);
        if (n >= MAX_RETURNS) return;
        setTimeout(function () {
            try {
                if (localStorage.getItem('KT11_BOT_ENABLED') !== '1') return;
                sessionStorage.setItem('kb_returns', String(n + 1));
                location.href = '/esale/products';
            } catch (e) {}
        }, RETURN_DELAY);
    } catch (e) {}
})();
(function () {
    var SEL = '[data-refresh-availability], .refresh-availability';
    var orig = Document.prototype.querySelector;
    function shown(el) { return !!el && el.getClientRects().length > 0; }
    Document.prototype.querySelector = function (sel) {
        var r = orig.apply(this, arguments);
        if (sel !== SEL || shown(r)) return r;
        try {
            var cands = orig.call(this, 'body') ? this.querySelectorAll('button, a, [role="button"]') : [];
            for (var i = 0; i < cands.length; i++) {
                var el = cands[i];
                if (el.closest && el.closest('[id^="kt11"]')) continue;
                if (!shown(el) || el.disabled) continue;
                var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t.indexOf('بروزرسانی') === 0 && t.length <= 30) return el;
            }
        } catch (e) {}
        return r;
    };
})();
(function () {
    var orig = console.log;
    console.log = function () {
        try {
            if (arguments[0] === '[KavirTire] Product found:' && typeof KTNative !== 'undefined') KTNative.alarm();
        } catch (e) {}
        return orig.apply(console, arguments);
    };
})();
(function () {
    var KEY = 'kb_panel_pos';
    function clamp(panel, l, t) {
        var w = panel.offsetWidth, vw = window.innerWidth, vh = window.innerHeight;
        l = Math.min(Math.max(l, 60 - w), vw - 60);
        t = Math.min(Math.max(t, 0), vh - 60);
        return [l, t];
    }
    function place(panel, l, t) {
        var p = clamp(panel, l, t);
        panel.style.setProperty('left', p[0] + 'px', 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('top', p[1] + 'px', 'important');
        return p;
    }
    function attach(panel) {
        if (panel.__kbDrag) return;
        var head = panel.querySelector('#kt11-head');
        if (!head) return;
        panel.__kbDrag = true;
        head.style.setProperty('touch-action', 'none');
        head.style.setProperty('cursor', 'move');
        try {
            var s = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (s && s.length === 2) place(panel, s[0], s[1]);
        } catch (e) {}
        var sx = 0, sy = 0, ol = 0, ot = 0, drag = false, pid = null;
        head.addEventListener('pointerdown', function (e) {
            if (e.target.closest && e.target.closest('button')) return;
            var r = panel.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; ol = r.left; ot = r.top;
            drag = true; pid = e.pointerId;
            try { head.setPointerCapture(pid); } catch (_) {}
            e.preventDefault();
        });
        head.addEventListener('pointermove', function (e) {
            if (!drag || e.pointerId !== pid) return;
            place(panel, ol + e.clientX - sx, ot + e.clientY - sy);
        });
        function end() {
            if (!drag) return;
            drag = false;
            var r = panel.getBoundingClientRect();
            try { localStorage.setItem(KEY, JSON.stringify([r.left, r.top])); } catch (_) {}
        }
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
        window.addEventListener('resize', function () {
            var r = panel.getBoundingClientRect();
            if (panel.style.getPropertyValue('left')) place(panel, r.left, r.top);
        });
    }
    setInterval(function () {
        var p = document.getElementById('kt11-dashboard');
        if (p) attach(p);
    }, 300);
})();

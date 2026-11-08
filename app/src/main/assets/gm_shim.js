// GM_getValue / GM_setValue on top of the native encrypted store.
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

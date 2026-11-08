# KavirBot (Android)

WebView app that runs your KT12 userscript unchanged (app/src/main/assets/KT12-_Panel.js)
with a native GM_getValue/GM_setValue shim (assets/gm_shim.js).

Build: open this folder in Android Studio (Koala+), let Gradle sync, Run.
Or: gradle assembleDebug  -> app/build/outputs/apk/debug/app-debug.apk

To update the bot logic: replace assets/KT12-_Panel.js and rebuild.

Storage: settings/card number -> EncryptedSharedPreferences (Keystore). CVV -> RAM only.

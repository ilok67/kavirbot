package ir.kavirbot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class KeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel("kb", "عاصم کویر بات", NotificationManager.IMPORTANCE_LOW))
        }
        val n = Notification.Builder(this).apply {
            if (Build.VERSION.SDK_INT >= 26) setChannelId("kb")
            setContentTitle("عاصم کویر بات فعال است")
            setSmallIcon(android.R.drawable.stat_notify_sync)
            setOngoing(true)
        }.build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(1, n)
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kavirbot:run").apply { acquire(60 * 60 * 1000L) }
    }

    override fun onDestroy() { wakeLock?.takeIf { it.isHeld }?.release(); super.onDestroy() }
    override fun onBind(i: Intent?): IBinder? = null
}

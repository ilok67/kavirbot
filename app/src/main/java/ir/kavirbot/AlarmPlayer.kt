package ir.kavirbot

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator

/** Loud looping alarm on the ALARM stream (max volume) + vibration. Auto-stops after 2 minutes. */
class AlarmPlayer(private val ctx: Context) {
    private var player: MediaPlayer? = null
    private var prevVolume = -1
    private val handler = Handler(Looper.getMainLooper())
    private val autoStop = Runnable { stop() }

    val isPlaying get() = player != null

    @Suppress("DEPRECATION")
    fun start() {
        if (player != null) return
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        runCatching {
            prevVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        }
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        player = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(ctx, uri)
                isLooping = true
                prepare()
                start()
            }
        }.getOrNull()
        val vib = ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        val pattern = longArrayOf(0, 800, 400)
        if (Build.VERSION.SDK_INT >= 26) vib?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        else vib?.vibrate(pattern, 0)
        handler.postDelayed(autoStop, 120_000)
    }

    @Suppress("DEPRECATION")
    fun stop() {
        handler.removeCallbacks(autoStop)
        player?.let { runCatching { it.stop() }; it.release() }
        player = null
        (ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)?.cancel()
        if (prevVolume >= 0) {
            val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0) }
            prevVolume = -1
        }
    }
}

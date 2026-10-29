package top.wennie99s.copilot2copilot.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import top.wennie99s.copilot2copilot.MainActivity
import top.wennie99s.copilot2copilot.R

class Notifier(private val context: Context) {
    companion object {
        const val CHANNEL_STATUS = "c2c_status"
        const val CHANNEL_MESSAGES = "c2c_messages"
        const val STATUS_NOTIFICATION_ID = 1001
        private var messageSeq = 2000
    }

    fun createChannels() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, context.getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = "前台服务常驻通知：连接状态"
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "收到同事消息或回复时的提醒"
            },
        )
    }

    /** 前台服务常驻通知 */
    fun statusNotification(title: String, text: String, ongoing: Boolean = true): android.app.Notification =
        NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(null))
            .build()

    /** 新消息通知（应用不在前台或不在该会话时调用） */
    fun notifyMessage(peerId: String, peerLabel: String, text: String) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(peerLabel.ifBlank { peerId })
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp(peerId))
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(messageSeq++, notification) }
    }

    private fun openApp(peerId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (!peerId.isNullOrBlank()) putExtra(MainActivity.EXTRA_PEER, peerId)
        }
        return PendingIntent.getActivity(
            context,
            peerId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}

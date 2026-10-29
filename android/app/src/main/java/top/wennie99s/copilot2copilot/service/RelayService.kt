package top.wennie99s.copilot2copilot.service

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import top.wennie99s.copilot2copilot.AppContainer
import top.wennie99s.copilot2copilot.C2CApp
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.notify.Notifier

/**
 * 前台服务：让长连接在应用退到后台后仍存活（Android 会冻结普通进程的后台 socket）。
 * 连接本体在 AppContainer 里，服务只负责保活与状态通知。
 */
class RelayService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var container: AppContainer

    override fun onCreate() {
        super.onCreate()
        container = (application as C2CApp).container
        val initial = container.notifier.statusNotification("Copilot2Copilot", "正在启动…")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            0
        }
        ServiceCompat.startForeground(this, Notifier.STATUS_NOTIFICATION_ID, initial, type)

        scope.launch {
            container.relay.state.collect { state ->
                val text = when (state.status) {
                    ConnStatus.Online -> "已连接" + if (state.relayVersion.isNotBlank()) " · ${state.relayVersion}" else ""
                    ConnStatus.Connecting -> state.detail
                    ConnStatus.Error -> state.detail
                    ConnStatus.Disconnected -> "未连接"
                }
                NotificationManagerCompat.from(this@RelayService)
                    .notify(Notifier.STATUS_NOTIFICATION_ID, container.notifier.statusNotification("Copilot2Copilot", text))
            }
        }

        scope.launch {
            val cfg = container.configStore.current()
            if (cfg.autoConnect && cfg.ready && container.relay.state.value.status == ConnStatus.Disconnected) {
                container.relay.connect(cfg)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}

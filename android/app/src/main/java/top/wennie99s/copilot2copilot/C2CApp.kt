package top.wennie99s.copilot2copilot

import android.app.Application
import android.content.Context
import top.wennie99s.copilot2copilot.data.ConfigStore
import top.wennie99s.copilot2copilot.data.HistoryStore
import top.wennie99s.copilot2copilot.net.RelayClient
import top.wennie99s.copilot2copilot.notify.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** 进程内单例：连接只有一条，界面与前台服务共用 */
class AppContainer(context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val configStore = ConfigStore(context)
    val history = HistoryStore(context)
    val relay = RelayClient(scope)
    val notifier = Notifier(context)
}

class C2CApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.notifier.createChannels()
    }
}

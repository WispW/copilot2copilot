package top.wennie99s.copilot2copilot

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import top.wennie99s.copilot2copilot.data.C2CConfig
import top.wennie99s.copilot2copilot.data.ChatMessage
import top.wennie99s.copilot2copilot.data.ConfigStore
import top.wennie99s.copilot2copilot.data.HistoryStore
import top.wennie99s.copilot2copilot.net.RelayClient
import top.wennie99s.copilot2copilot.notify.Notifier
import top.wennie99s.copilot2copilot.protocol.Envelope
import top.wennie99s.copilot2copilot.protocol.preview
import java.util.concurrent.ConcurrentHashMap

/**
 * 进程内单例：连接只有一条，界面与前台服务共用。
 *
 * 消息的「落盘 + 通知」放在这里而不是 ViewModel：Activity 被销毁（划掉应用、系统回收）
 * 而前台服务仍存活时，事件仍会被处理；ViewModel 只负责展示状态。
 */
class AppContainer(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val configStore = ConfigStore(context)
    val history = HistoryStore(context)
    val relay = RelayClient(scope)
    val notifier = Notifier(context)

    /** 应用是否在前台（决定是否发系统通知） */
    @Volatile
    var appVisible: Boolean = false

    /** 当前正在查看的会话：该会话的消息不弹通知 */
    @Volatile
    var activePeer: String? = null

    /** 同事 id → 通知标题（来自中继下发的档案） */
    private val peerLabels = ConcurrentHashMap<String, String>()

    init {
        scope.launch { history.ensureLoaded() }
        scope.launch { relay.events.collect { persistAndNotify(it) } }
    }

    /** 常驻消费：消息 / 回复落盘 + 未读通知（与界面是否存活无关） */
    private suspend fun persistAndNotify(env: Envelope) {
        when (env.kind) {
            "presence" -> {
                peerLabels.clear()
                for (profile in env.profiles) {
                    peerLabels[profile.id] = if (profile.role.isBlank()) profile.id else "${profile.id}（${profile.role}）"
                }
            }

            "message" -> {
                if (env.from == me()) return
                val added = history.append(
                    ChatMessage(
                        id = env.id,
                        peerId = env.from,
                        direction = "in",
                        text = env.text ?: "",
                        snippet = env.snippet,
                        intent = env.intent,
                        ts = env.ts.takeIf { it > 0 } ?: System.currentTimeMillis(),
                        done = false,
                        requestId = env.id,
                        read = false,
                    ),
                )
                if (added) {
                    maybeNotify(env.from, env.text)
                }
            }

            "reply" -> {
                env.requestId?.let { history.markDone(it) }
                val added = history.append(
                    ChatMessage(
                        id = env.id,
                        peerId = env.from,
                        direction = "in",
                        text = env.text ?: "",
                        snippet = env.snippet,
                        ts = env.ts.takeIf { it > 0 } ?: System.currentTimeMillis(),
                        done = true,
                        requestId = env.requestId,
                        read = false,
                    ),
                )
                if (added) {
                    maybeNotify(env.from, env.text)
                }
            }
        }
    }

    private fun maybeNotify(peerId: String, text: String?) {
        if (appVisible && activePeer == peerId) {
            return
        }
        notifier.notifyMessage(peerId, peerLabels[peerId] ?: peerId, (text ?: "").preview(120))
    }

    private suspend fun me(): String = configStore.current().id.trim()

    suspend fun currentConfig(): C2CConfig = configStore.current()
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

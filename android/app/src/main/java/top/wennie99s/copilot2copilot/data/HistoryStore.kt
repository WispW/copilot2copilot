package top.wennie99s.copilot2copilot.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 一条聊天记录：direction=in 收到，out 发出 */
data class ChatMessage(
    val id: String,
    val peerId: String,
    val direction: String,
    val text: String,
    val snippet: String? = null,
    val intent: String? = null,
    val ts: Long,
    /** 发出的消息是否已收到回复 */
    val done: Boolean = true,
    /** reply 关联的原消息 id */
    val requestId: String? = null,
    /** 本地待发标记（对方离线/通道断开） */
    val queued: Boolean = false,
    /** 是否已读（入站消息在打开会话后置为 true，并持久化，避免重启后整屏红点） */
    val read: Boolean = false,
)

/**
 * 聊天历史：JSON 文件持久化（应用私有目录），最多保留 [LIMIT] 条。
 * 只存对话正文，不存房间 / 记忆等可从中间拉取的数据。
 */
class HistoryStore(context: Context) {
    private val file = File(context.filesDir, "history.json")
    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    private val loadMutex = Mutex()
    @Volatile
    private var loaded = false

    companion object {
        private const val LIMIT = 500
    }

    /**
     * 只从文件加载一次。前台服务与界面都会触发初始化，若各自 load 一次会互相覆盖：
     * 先到的消息被后一次 load 用文件内容盖掉，表现为「早期消息丢失」。
     */
    suspend fun ensureLoaded() {
        if (loaded) {
            return
        }
        loadMutex.withLock {
            if (loaded) {
                return
            }
            loadInternal()
            loaded = true
        }
    }

    /** 兼容旧调用点：等价于 ensureLoaded */
    suspend fun load() = ensureLoaded()

    private suspend fun loadInternal() = withContext(Dispatchers.IO) {
        val list = runCatching {
            if (!file.exists()) return@runCatching emptyList()
            val arr = JSONArray(file.readText())
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { o ->
                    ChatMessage(
                        id = o.optString("id"),
                        peerId = o.optString("peerId"),
                        direction = o.optString("direction"),
                        text = o.optString("text"),
                        snippet = if (o.isNull("snippet")) null else o.optString("snippet"),
                        intent = if (o.isNull("intent")) null else o.optString("intent"),
                        ts = o.optLong("ts"),
                        done = o.optBoolean("done", true),
                        requestId = if (o.isNull("requestId")) null else o.optString("requestId"),
                        queued = o.optBoolean("queued", false),
                        // 旧数据没有 read 字段：按已读处理，避免升级后整屏红点
                        read = o.optBoolean("read", true),
                    )
                }
            }
        }.getOrDefault(emptyList())
        _messages.value = list
    }

    suspend fun append(message: ChatMessage) {
        ensureLoaded()
        // 事件流有 replay：同一条消息可能被重复投递，按 id 去重
        if (_messages.value.any { it.id == message.id }) {
            return
        }
        _messages.value = (_messages.value + message).takeLast(LIMIT)
        persist()
    }

    suspend fun markDone(id: String) {
        ensureLoaded()
        val next = _messages.value.map { if (it.id == id) it.copy(done = true, queued = false) else it }
        if (next != _messages.value) {
            _messages.value = next
            persist()
        }
    }

    /** 打开某个会话时调用：把该同事的入站消息全部标记为已读并落盘（重启后不再重复红点） */
    suspend fun markPeerRead(peerId: String) {
        ensureLoaded()
        val next = _messages.value.map {
            if (it.peerId == peerId && it.direction == "in" && !it.read) it.copy(read = true) else it
        }
        if (next != _messages.value) {
            _messages.value = next
            persist()
        }
    }

    suspend fun clear() {
        _messages.value = emptyList()
        persist()
    }

    private suspend fun persist() = withContext(Dispatchers.IO) {
        runCatching {
            val arr = JSONArray()
            for (m in _messages.value) {
                arr.put(JSONObject().apply {
                    put("id", m.id)
                    put("peerId", m.peerId)
                    put("direction", m.direction)
                    put("text", m.text)
                    m.snippet?.let { put("snippet", it) }
                    m.intent?.let { put("intent", it) }
                    put("ts", m.ts)
                    put("done", m.done)
                    m.requestId?.let { put("requestId", it) }
                    put("queued", m.queued)
                    put("read", m.read)
                })
            }
            val tmp = File(file.parentFile, "history.json.tmp")
            tmp.writeText(arr.toString())
            if (!tmp.renameTo(file)) {
                // renameTo 在部分文件系统上会失败：忽略返回值曾导致落盘静默丢失
                file.writeText(arr.toString())
                tmp.delete()
            }
        }
    }
}

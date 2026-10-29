package top.wennie99s.copilot2copilot.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import top.wennie99s.copilot2copilot.C2CApp
import top.wennie99s.copilot2copilot.data.C2CConfig
import top.wennie99s.copilot2copilot.data.ChatMessage
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.net.ConnectionState
import top.wennie99s.copilot2copilot.protocol.Envelope
import top.wennie99s.copilot2copilot.protocol.MemoryItem
import top.wennie99s.copilot2copilot.protocol.Profile
import top.wennie99s.copilot2copilot.protocol.RoomCategory
import top.wennie99s.copilot2copilot.protocol.RoomInfo
import top.wennie99s.copilot2copilot.protocol.preview

data class MemoryUi(
    val roomId: String = "",
    val entries: List<MemoryItem> = emptyList(),
    val total: Int = 0,
    val loading: Boolean = false,
    val error: String? = null,
)

data class UiState(
    val config: C2CConfig = C2CConfig(),
    val conn: ConnectionState = ConnectionState(),
    /** 同房间在线的其他设备（id → 档案）；手机自己不在其中 */
    val peers: Map<String, Profile> = emptyMap(),
    val rooms: List<RoomInfo> = emptyList(),
    val categories: List<RoomCategory> = emptyList(),
    val messages: List<ChatMessage> = emptyList(),
    val memory: MemoryUi = MemoryUi(),
    /** 一次性提示（Snackbar） */
    val notice: String? = null,
) {
    /** 未读 = 入站且未标记已读（已读状态随历史一起落盘，重启后保持） */
    val unreadByPeer: Map<String, Int>
        get() = messages
            .filter { it.direction == "in" && !it.read }
            .groupingBy { it.peerId }
            .eachCount()

    val unreadTotal: Int get() = unreadByPeer.values.sum()
}

class C2CViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as C2CApp).container
    private val relay = container.relay
    private val history = container.history
    private val configStore = container.configStore
    private val notifier = container.notifier

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** 应用是否在前台、当前正在看的会话（决定是否发系统通知） */
    @Volatile
    var appVisible: Boolean = false
    @Volatile
    var activePeer: String? = null
    @Volatile
    var memoryRoom: String? = null

    init {
        observe()
        bootstrap()
    }

    private fun observe() {
        viewModelScope.launch {
            configStore.config.collect { cfg ->
                _state.update { it.copy(config = cfg) }
                relay.updateConfig(cfg)
            }
        }
        viewModelScope.launch {
            relay.state.collect { conn ->
                _state.update { current ->
                    current.copy(
                        conn = conn,
                        // 断开后不再显示「在线」绿点：可见性以中继 presence 为准
                        peers = if (conn.status == ConnStatus.Online) current.peers else emptyMap(),
                    )
                }
            }
        }
        viewModelScope.launch {
            history.messages.collect { messages ->
                _state.update { it.copy(messages = messages) }
            }
        }
        viewModelScope.launch {
            relay.events.collect { handleEvent(it) }
        }
    }

    private fun bootstrap() {
        viewModelScope.launch {
            history.ensureLoaded()
            val cfg = configStore.current()
            _state.update { it.copy(config = cfg) }
            relay.updateConfig(cfg)
            if (cfg.autoConnect && cfg.ready) {
                relay.connect(cfg)
            }
        }
    }

    private suspend fun handleEvent(env: Envelope) {
        when (env.kind) {
            "presence" -> {
                // 中继下发的是「当前可见在线档案」全量，直接替换；下线的人会随之消失
                val visible = env.profiles.filter { it.id != me() }.associateBy { it.id }
                _state.update { it.copy(peers = visible) }
            }

            "room-event" -> {
                _state.update { it.copy(rooms = env.rooms, categories = env.categories) }
            }

            "message" -> {
                if (env.from == me()) return
                val text = env.text ?: ""
                history.append(
                    ChatMessage(
                        id = env.id,
                        peerId = env.from,
                        direction = "in",
                        text = text,
                        snippet = env.snippet,
                        intent = env.intent,
                        ts = env.ts.takeIf { it > 0 } ?: System.currentTimeMillis(),
                        done = false,
                        requestId = env.id,
                        read = false,
                    ),
                )
                if (!appVisible || activePeer != env.from) {
                    notifier.notifyMessage(env.from, labelOf(env.from), text.preview(120))
                }
            }

            "reply" -> {
                env.requestId?.let { history.markDone(it) }
                history.append(
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
                if (!appVisible || activePeer != env.from) {
                    notifier.notifyMessage(env.from, labelOf(env.from), (env.text ?: "").preview(120))
                }
            }

            "error" -> {
                val reason = env.error ?: "操作被中继拒绝"
                _state.update { it.copy(notice = reason) }
            }

            "memory-event" -> {
                val payload = env.payload
                val roomId = payload?.optString("roomId") ?: env.roomId
                if (!roomId.isNullOrBlank() && roomId == memoryRoom) {
                    loadMemory(roomId)
                }
            }
        }
    }

    // ---------- 连接 ----------

    fun saveAndConnect(config: C2CConfig) {
        viewModelScope.launch {
            configStore.save(config)
            val reconnectNeeded = relay.state.value.status == ConnStatus.Online
            if (reconnectNeeded) relay.disconnect()
            relay.updateConfig(config)
            if (config.ready) relay.connect(config)
        }
    }

    fun connect() {
        val cfg = _state.value.config
        if (!cfg.ready) {
            _state.update { it.copy(notice = "请先填写中继地址、id、角色与负责内容") }
            return
        }
        relay.connect(cfg)
    }

    fun disconnect() = relay.disconnect()

    // ---------- 消息 ----------

    fun sendMessage(peerId: String, text: String, intent: String, snippet: String? = null) {
        if (text.isBlank()) return
        if (relay.state.value.status != ConnStatus.Online) {
            _state.update { it.copy(notice = "通道未连接，消息未发送") }
            return
        }
        val id = relay.sendMessage(peerId, text, intent, snippet)
        if (id == null) {
            _state.update { it.copy(notice = "发送失败：通道已断开") }
            return
        }
        viewModelScope.launch {
            history.append(
                ChatMessage(
                    id = id,
                    peerId = peerId,
                    direction = "out",
                    text = text,
                    snippet = snippet,
                    intent = intent,
                    ts = System.currentTimeMillis(),
                    done = false,
                    read = true,
                ),
            )
            markRead(peerId)
        }
    }

    fun reply(peerId: String, requestId: String, text: String) {
        if (text.isBlank()) return
        val id = relay.reply(peerId, requestId, text)
        if (id == null) {
            _state.update { it.copy(notice = "回复失败：通道已断开") }
            return
        }
        viewModelScope.launch {
            history.append(
                ChatMessage(
                    id = id,
                    peerId = peerId,
                    direction = "out",
                    text = text,
                    ts = System.currentTimeMillis(),
                    done = true,
                    requestId = requestId,
                    read = true,
                ),
            )
            markRead(peerId)
        }
    }

    fun markRead(peerId: String) {
        viewModelScope.launch { history.markPeerRead(peerId) }
    }

    fun clearNotice() {
        _state.update { it.copy(notice = null) }
    }

    // ---------- 房间 ----------

    fun refreshRooms() {
        viewModelScope.launch {
            val res = runCatching { relay.request("room", "list") }
            res.onSuccess { env ->
                if (!env.ok) {
                    _state.update { it.copy(notice = env.error ?: "获取房间失败") }
                    return@onSuccess
                }
                val payload = env.payload ?: return@onSuccess
                val rooms = payload.optJSONArray("rooms")?.let(Envelope.Companion::rooms) ?: emptyList()
                val categories = payload.optJSONArray("categories")?.let { arr ->
                    (0 until arr.length()).mapNotNull { i ->
                        arr.optJSONObject(i)?.let { RoomCategory(it.optString("id"), it.optString("name")) }
                    }
                } ?: emptyList()
                _state.update { it.copy(rooms = rooms, categories = categories) }
            }.onFailure { e ->
                _state.update { it.copy(notice = "获取房间失败：${e.message}") }
            }
        }
    }

    fun joinRoom(roomId: String, password: String) {
        viewModelScope.launch {
            runCatching {
                relay.request("room", "join", JSONObject().apply {
                    put("roomId", roomId)
                    if (password.isNotBlank()) put("password", password)
                })
            }.onSuccess { env ->
                if (!env.ok) _state.update { it.copy(notice = env.error ?: "加入房间失败") }
                else {
                    _state.update { it.copy(notice = "已加入房间") }
                    refreshRooms()
                }
            }.onFailure { e -> _state.update { it.copy(notice = "加入失败：${e.message}") } }
        }
    }

    fun leaveRoom(roomId: String) {
        viewModelScope.launch {
            runCatching { relay.request("room", "leave", JSONObject().put("roomId", roomId)) }
                .onSuccess { env ->
                    if (!env.ok) _state.update { it.copy(notice = env.error ?: "退出房间失败") }
                    else {
                        _state.update { it.copy(notice = "已退出房间") }
                        refreshRooms()
                    }
                }
                .onFailure { e -> _state.update { it.copy(notice = "退出失败：${e.message}") } }
        }
    }

    // ---------- 共享记忆 ----------

    fun openMemory(roomId: String) {
        memoryRoom = roomId
        _state.update { it.copy(memory = MemoryUi(roomId = roomId, loading = true)) }
        loadMemory(roomId)
    }

    fun loadMemory(roomId: String) {
        if (roomId.isBlank()) return
        viewModelScope.launch {
            _state.update { it.copy(memory = it.memory.copy(roomId = roomId, loading = true, error = null)) }
            runCatching {
                relay.request("memory", "list", JSONObject().apply {
                    put("roomId", roomId)
                    put("limit", 50)
                })
            }.onSuccess { env ->
                if (!env.ok) {
                    _state.update { it.copy(memory = it.memory.copy(loading = false, error = env.error ?: "读取失败")) }
                    return@onSuccess
                }
                val payload = env.payload
                val entries = payload?.optJSONArray("entries")?.let(Envelope.Companion::memoryItems) ?: emptyList()
                _state.update {
                    it.copy(memory = it.memory.copy(loading = false, entries = entries, total = payload?.optInt("total") ?: entries.size))
                }
            }.onFailure { e ->
                _state.update { it.copy(memory = it.memory.copy(loading = false, error = "读取失败：${e.message}")) }
            }
        }
    }

    fun queryMemory(roomId: String, query: String) {
        if (query.isBlank()) {
            loadMemory(roomId)
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(memory = it.memory.copy(roomId = roomId, loading = true, error = null)) }
            runCatching {
                relay.request("memory", "query", JSONObject().apply {
                    put("roomId", roomId)
                    put("query", query)
                    put("topK", 20)
                })
            }.onSuccess { env ->
                if (!env.ok) {
                    _state.update { it.copy(memory = it.memory.copy(loading = false, error = env.error ?: "检索失败")) }
                    return@onSuccess
                }
                val payload = env.payload
                val results = payload?.optJSONArray("results")?.let(Envelope.Companion::memoryItems) ?: emptyList()
                _state.update {
                    it.copy(
                        memory = it.memory.copy(
                            loading = false,
                            entries = results,
                            total = results.size,
                            error = if (results.isEmpty()) (payload?.optString("hint") ?: "没有匹配的记忆") else null,
                        ),
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(memory = it.memory.copy(loading = false, error = "检索失败：${e.message}")) }
            }
        }
    }

    fun remember(roomId: String, text: String, tags: List<String> = emptyList()) {
        if (text.isBlank()) return
        viewModelScope.launch {
            runCatching {
                relay.request("memory", "remember", JSONObject().apply {
                    put("roomId", roomId)
                    put("text", text.trim())
                    if (tags.isNotEmpty()) put("tags", JSONArray(tags))
                })
            }.onSuccess { env ->
                if (!env.ok) _state.update { it.copy(notice = env.error ?: "写入记忆失败") }
                else {
                    _state.update { it.copy(notice = "已写入共享记忆") }
                    loadMemory(roomId)
                }
            }.onFailure { e -> _state.update { it.copy(notice = "写入失败：${e.message}") } }
        }
    }

    fun updateMemory(roomId: String, entryId: String, text: String, revision: Int) {
        if (text.isBlank()) return
        viewModelScope.launch {
            runCatching {
                relay.request("memory", "update", JSONObject().apply {
                    put("entryId", entryId)
                    put("text", text.trim())
                    put("revision", revision)
                })
            }.onSuccess { env ->
                if (!env.ok) _state.update { it.copy(notice = env.error ?: "修改失败（可能已被他人修改）") }
                else {
                    _state.update { it.copy(notice = "已更新") }
                    loadMemory(roomId)
                }
            }.onFailure { e -> _state.update { it.copy(notice = "修改失败：${e.message}") } }
        }
    }

    fun deleteMemory(roomId: String, entryId: String, revision: Int) {
        viewModelScope.launch {
            runCatching {
                relay.request("memory", "delete", JSONObject().apply {
                    put("entryId", entryId)
                    put("revision", revision)
                })
            }.onSuccess { env ->
                if (!env.ok) _state.update { it.copy(notice = env.error ?: "删除失败") }
                else {
                    _state.update { it.copy(notice = "已删除（可在回收站恢复）") }
                    loadMemory(roomId)
                }
            }.onFailure { e -> _state.update { it.copy(notice = "删除失败：${e.message}") } }
        }
    }

    // ---------- 查询辅助 ----------

    private fun me(): String = _state.value.config.id.trim()

    fun labelOf(peerId: String): String {
        val p = _state.value.peers[peerId] ?: return peerId
        return if (p.role.isBlank()) peerId else "${p.id}（${p.role}）"
    }
}

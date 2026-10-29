package top.wennie99s.copilot2copilot.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import top.wennie99s.copilot2copilot.data.C2CConfig
import top.wennie99s.copilot2copilot.protocol.C2C
import top.wennie99s.copilot2copilot.protocol.Envelope
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

enum class ConnStatus { Disconnected, Connecting, Online, Error }

data class ConnectionState(
    val status: ConnStatus = ConnStatus.Disconnected,
    val detail: String = "未连接",
    val relayVersion: String = "",
    val since: Long = 0L,
)

/**
 * 中继客户端（手机端实现，协议与 VS Code 扩展一致）：
 * - 握手：`x-client-kind: mobile` + `x-protocol: 7`（中继对非扩展客户端按协议号门禁）
 * - 连接前先读 /healthz 校验协议号，避免连上后被 4008 拒
 * - 自动重连：1s 起指数退避到 30s；需要人工处理的关闭码（令牌/封禁/版本）停在错误态
 * - 控制面请求-应答：`request(kind, op, payload)`，按信封 id 关联响应
 */
class RelayClient(private val scope: CoroutineScope) {
    private val okHttp: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val _state = MutableStateFlow(ConnectionState())
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    // replay：前台服务可能先建连并收到消息，界面稍后订阅；给最近的帧留缓冲，避免早期消息丢失。
    // 历史层按消息 id 去重，重放不会产生重复气泡。
    private val _events = MutableSharedFlow<Envelope>(replay = 32, extraBufferCapacity = 128)
    val events: SharedFlow<Envelope> = _events.asSharedFlow()

    private var cfg: C2CConfig? = null
    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var manualStop = true
    private var attempt = 0
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Envelope>>()

    init {
        // 控制面响应按 id 关联；UI 侧也会订阅 events，二者互不影响
        scope.launch {
            _events.collect { env -> pending.remove(env.id)?.complete(env) }
        }
    }

    /** 配置变更（id / 档案）后由界面调用；在线时立即重新上报档案 */
    fun updateConfig(next: C2CConfig) {
        val identityChanged = cfg?.id != next.id || cfg?.role != next.role || cfg?.scope != next.scope
        cfg = next
        if (identityChanged && _state.value.status == ConnStatus.Online) {
            reportProfile()
        }
    }

    fun connect(config: C2CConfig) {
        cfg = config
        if (!config.ready) {
            _state.value = ConnectionState(ConnStatus.Error, "请先填写中继地址、id、角色与负责内容")
            return
        }
        // 幂等：前台服务与界面都会触发自动连接，已在连接中/在线时直接返回，
        // 否则会先关旧连接再连新的，中继来不及处理关闭就收到新连接，报 4005「id 已在线」
        if (!manualStop && (_state.value.status == ConnStatus.Online || _state.value.status == ConnStatus.Connecting)) {
            return
        }
        manualStop = false
        attempt = 0
        reconnectJob?.cancel()
        closeSocket()
        scope.launch { doConnect() }
    }

    fun disconnect() {
        manualStop = true
        reconnectJob?.cancel()
        closeSocket()
        _state.value = ConnectionState(ConnStatus.Disconnected, "已断开", _state.value.relayVersion)
    }

    /** 上报本机档案（中继是档案的唯一权威来源） */
    private fun reportProfile() {
        val c = cfg ?: return
        send(JSONObject().apply {
            put("v", C2C.PROTOCOL_VERSION)
            put("kind", "hello")
            put("id", newId("h"))
            put("from", c.id)
            put("to", "server")
            put("ts", now())
            put("profile", JSONObject().apply {
                put("id", c.id)
                put("role", c.role)
                put("scope", c.scope)
            })
        })
    }

    fun sendMessage(to: String, text: String, intent: String, snippet: String? = null): String? {
        val id = newId("m")
        val ok = send(JSONObject().apply {
            put("v", C2C.PROTOCOL_VERSION)
            put("kind", "message")
            put("id", id)
            put("from", cfg?.id ?: "")
            put("to", to)
            put("ts", now())
            put("text", text)
            if (!snippet.isNullOrBlank()) put("snippet", snippet)
            put("intent", intent)
            put("profile", profileJson())
        })
        return if (ok) id else null
    }

    fun reply(to: String, requestId: String, text: String): String? {
        val id = newId("p")
        val ok = send(JSONObject().apply {
            put("v", C2C.PROTOCOL_VERSION)
            put("kind", "reply")
            put("id", id)
            put("from", cfg?.id ?: "")
            put("to", to)
            put("ts", now())
            put("text", text)
            put("requestId", requestId)
            put("profile", profileJson())
        })
        return if (ok) id else null
    }

    /** 控制面请求（room / memory / admin），返回与请求 id 匹配的应答信封 */
    suspend fun request(kind: String, op: String, payload: JSONObject = JSONObject()): Envelope {
        val id = newId("r")
        val deferred = CompletableDeferred<Envelope>()
        pending[id] = deferred
        val sent = send(JSONObject().apply {
            put("v", C2C.PROTOCOL_VERSION)
            put("kind", kind)
            put("id", id)
            put("from", cfg?.id ?: "")
            put("to", "server")
            put("ts", now())
            put("op", op)
            put("payload", payload)
        })
        if (!sent) {
            pending.remove(id)
            throw IOException("通道未连接")
        }
        return try {
            withTimeout(10_000) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            throw IOException("请求超时：$op")
        } finally {
            pending.remove(id)
        }
    }

    private fun send(env: JSONObject): Boolean {
        val ws = webSocket ?: return false
        return ws.send(env.toString())
    }

    private fun profileJson(): JSONObject = JSONObject().apply {
        put("id", cfg?.id ?: "")
        put("role", cfg?.role ?: "")
        put("scope", cfg?.scope ?: "")
    }

    private suspend fun doConnect() {
        val c = cfg ?: return
        if (manualStop) return
        _state.value = ConnectionState(ConnStatus.Connecting, "正在检查中继…", _state.value.relayVersion)
        val base = normalizeBase(c.relayUrl)
        val health = withContext(Dispatchers.IO) { runCatching { fetchHealth(base) }.getOrNull() }
        if (health == null) {
            // 中继重启 / 网络瞬断都表现为探测失败：走退避重试，不能停在错误态
            scheduleReconnect("无法访问 $base/healthz，请检查地址与网络")
            return
        }
        val relayVersion = health.optString("version")
        val protocol = health.optInt("protocol", -1)
        if (protocol != C2C.PROTOCOL_VERSION) {
            onFatal("中继协议 v$protocol 与本 App 支持的 v${C2C.PROTOCOL_VERSION} 不一致，请升级对应一方")
            return
        }
        if (!health.optBoolean("mobileEnabled", true)) {
            onFatal("中继未开启手机接入：请在中继配置 TALK2COPILOT_MOBILE_TOKEN，并在本页填写同一令牌")
            return
        }
        val wsUrl = "${wsBase(base)}/ws?id=${URLEncoder.encode(c.id, "UTF-8")}"
        val request = Request.Builder()
            .url(wsUrl)
            .header("authorization", "Bearer ${c.token}")
            .header("x-client-kind", C2C.CLIENT_KIND)
            .header("x-protocol", C2C.PROTOCOL_VERSION.toString())
            // 手机专用令牌：中继据此签发 mobile 身份（未配置或错误会被 4009 拒绝）
            .header("x-mobile-token", c.mobileToken)
            // 仅供中继管理页展示；mobile 的门禁看的是 x-protocol，不是版本号
            .header("x-client-version", C2C.APP_VERSION)
            .build()
        _state.value = ConnectionState(ConnStatus.Connecting, "正在建立连接…", relayVersion)
        if (manualStop) return
        webSocket = okHttp.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempt = 0
            _state.value = _state.value.copy(status = ConnStatus.Online, detail = "已连接", since = System.currentTimeMillis())
            reportProfile()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val env = Envelope.parse(text) ?: return
            _events.tryEmit(env)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (this@RelayClient.webSocket !== webSocket) return
            this@RelayClient.webSocket = null
            if (manualStop) return
            scheduleReconnect("连接中断：${t.message ?: t.javaClass.simpleName}")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (this@RelayClient.webSocket !== webSocket) return
            this@RelayClient.webSocket = null
            if (manualStop) {
                _state.value = ConnectionState(ConnStatus.Disconnected, "已断开", _state.value.relayVersion)
                return
            }
            if (code in FATAL_CODES) {
                onFatal("${describeClose(code)}（$code${if (reason.isNotBlank()) "：$reason" else ""}）")
            } else {
                scheduleReconnect(describeClose(code))
            }
        }
    }

    private fun scheduleReconnect(reason: String) {
        if (manualStop || cfg == null) return
        reconnectJob?.cancel()
        // 1s → 2 → 4 → 8 → 16 → 30（上限 30s，与界面/文档文案一致），另加 0.6s 内抖动避免同时重连
        val baseDelaySec = minOf(1L shl min(attempt, 5), 30L)
        val delayMs = baseDelaySec * 1000L + Random.nextLong(0, 600)
        attempt += 1
        _state.value = _state.value.copy(
            status = ConnStatus.Connecting,
            detail = "$reason；${delayMs / 1000} 秒后重试",
        )
        reconnectJob = scope.launch {
            delay(delayMs)
            if (!manualStop) doConnect()
        }
    }

    private fun onFatal(message: String) {
        manualStop = true
        reconnectJob?.cancel()
        closeSocket()
        _state.value = ConnectionState(ConnStatus.Error, message, _state.value.relayVersion)
    }

    private fun closeSocket() {
        val ws = webSocket
        webSocket = null
        runCatching { ws?.close(1000, "client disconnect") }
    }

    private fun fetchHealth(base: String): JSONObject? {
        val request = Request.Builder().url("$base/healthz").build()
        okHttp.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body?.string() ?: return null
            return JSONObject(body)
        }
    }

    private fun newId(prefix: String): String =
        "$prefix${System.currentTimeMillis().toString(36)}${Random.nextInt(0, 0x10000).toString(16)}"

    private fun now(): Long = System.currentTimeMillis()

    companion object {
        /** 需要人工处理的关闭码：不自动重连，直接给下一步提示 */
        private val FATAL_CODES = setOf(4001, 4002, 4003, 4005, 4006, 4007, 4008, 4009)

        private fun describeClose(code: Int): String = when (code) {
            4001 -> "中继令牌不正确"
            4002 -> "未上报设备 id"
            4003 -> "id 是保留地址"
            4005 -> "该 id 已在线（同一 id 不能同时连两个设备）"
            4006 -> "已被中继管理员踢出"
            4007 -> "已被中继封禁"
            4008 -> "版本 / 协议不一致"
            4009 -> "手机专用令牌不正确，或中继未配置手机接入"
            1000 -> "连接已关闭"
            1001 -> "中继正在重启"
            else -> "连接断开"
        }

        /** 用户可只填主机名：默认按 wss 处理；http(s) 在这里统一成探针用的形式 */
        fun normalizeBase(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) return ""
            val withScheme = if (trimmed.contains("://")) trimmed else "wss://$trimmed"
            return withScheme
                .replaceFirst(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
                .replaceFirst(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
        }

        private fun wsBase(base: String): String =
            base.replaceFirst(Regex("^http://", RegexOption.IGNORE_CASE), "ws://")
                .replaceFirst(Regex("^https://", RegexOption.IGNORE_CASE), "wss://")
    }
}

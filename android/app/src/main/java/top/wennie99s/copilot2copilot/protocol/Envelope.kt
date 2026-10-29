package top.wennie99s.copilot2copilot.protocol

import org.json.JSONArray
import org.json.JSONObject

/** 与中继 / VS Code 扩展共享的协议常量 */
object C2C {
    /** 协议号：与 src/protocol.ts 的 PROTOCOL_VERSION、relay/server.js 的 PROTOCOL 一致 */
    const val PROTOCOL_VERSION = 7

    /** 设备类型：手机是人工终端（可见、可收发消息，不接受写任务） */
    const val CLIENT_KIND = "mobile"

    /** App 版本（仅供中继管理页展示，不参与门禁；协议号决定兼容性） */
    const val APP_VERSION = "2026.10.30"
}

data class Profile(
    val id: String,
    val role: String,
    val scope: String,
    val kind: String = "extension",
)

data class RoomInfo(
    val id: String,
    val name: String,
    val categoryId: String = "",
    val hasPassword: Boolean = false,
    val memberCount: Int = 0,
    val memoryCount: Int = 0,
    val joined: Boolean = false,
    val members: List<String> = emptyList(),
    val onlineMembers: List<String> = emptyList(),
)

data class RoomCategory(val id: String, val name: String)

data class MemoryItem(
    val id: String,
    val roomId: String,
    val roomName: String,
    val text: String,
    val tags: List<String> = emptyList(),
    val author: String = "",
    val updatedBy: String = "",
    val updatedAt: Long = 0L,
    val revision: Int = 1,
    val deleted: Boolean = false,
    val score: Double = 0.0,
)

/**
 * 中继信封。字段与 src/protocol.ts 的 MessageEnvelope 对应；
 * 控制面载荷（payload）保持 JSONObject，由各页面按 op 自行解释。
 */
data class Envelope(
    val kind: String,
    val id: String,
    val from: String,
    val to: String,
    val ts: Long,
    val text: String? = null,
    val snippet: String? = null,
    val snippetLanguage: String? = null,
    val intent: String? = null,
    val requestId: String? = null,
    val error: String? = null,
    val refId: String? = null,
    val profile: Profile? = null,
    val peers: List<String> = emptyList(),
    val profiles: List<Profile> = emptyList(),
    val rooms: List<RoomInfo> = emptyList(),
    val categories: List<RoomCategory> = emptyList(),
    val op: String? = null,
    val payload: JSONObject? = null,
    val ok: Boolean = false,
    val roomId: String? = null,
    val raw: JSONObject = JSONObject(),
) {
    companion object {
        fun parse(text: String): Envelope? = runCatching { from(JSONObject(text)) }.getOrNull()

        fun from(o: JSONObject): Envelope = Envelope(
            kind = o.optString("kind"),
            id = o.optString("id"),
            from = o.optString("from"),
            to = o.optString("to"),
            ts = o.optLong("ts", 0L),
            text = o.optStringOrNull("text"),
            snippet = o.optStringOrNull("snippet"),
            snippetLanguage = o.optStringOrNull("snippetLanguage"),
            intent = o.optStringOrNull("intent"),
            requestId = o.optStringOrNull("requestId"),
            error = o.optStringOrNull("error"),
            refId = o.optStringOrNull("refId"),
            profile = o.optJSONObject("profile")?.let(::profile),
            peers = o.optJSONArray("peers")?.toStringList() ?: emptyList(),
            profiles = o.optJSONArray("profiles")?.let { arr ->
                (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::profile) }
            } ?: emptyList(),
            rooms = o.optJSONArray("rooms")?.let(::rooms) ?: emptyList(),
            categories = o.optJSONArray("categories")?.let { arr ->
                (0 until arr.length()).mapNotNull { i ->
                    arr.optJSONObject(i)?.let { RoomCategory(it.optString("id"), it.optString("name")) }
                }
            } ?: emptyList(),
            op = o.optStringOrNull("op"),
            payload = o.optJSONObject("payload"),
            ok = o.optBoolean("ok", false),
            roomId = o.optStringOrNull("roomId"),
            raw = o,
        )

        fun profile(o: JSONObject): Profile = Profile(
            id = o.optString("id"),
            role = o.optString("role"),
            scope = o.optString("scope"),
            kind = o.optString("kind", "extension"),
        )

        fun rooms(arr: JSONArray): List<RoomInfo> = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o ->
                RoomInfo(
                    id = o.optString("id"),
                    name = o.optString("name"),
                    categoryId = o.optString("categoryId"),
                    hasPassword = o.optBoolean("hasPassword"),
                    memberCount = o.optInt("memberCount"),
                    memoryCount = o.optInt("memoryCount"),
                    joined = o.optBoolean("joined"),
                    members = o.optJSONArray("members")?.toStringList() ?: emptyList(),
                    onlineMembers = o.optJSONArray("onlineMembers")?.toStringList() ?: emptyList(),
                )
            }
        }

        fun memoryItems(arr: JSONArray): List<MemoryItem> = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let(::memoryItem)
        }

        fun memoryItem(o: JSONObject): MemoryItem = MemoryItem(
            id = o.optString("id"),
            roomId = o.optString("roomId"),
            roomName = o.optString("roomName"),
            text = o.optString("text"),
            tags = o.optJSONArray("tags")?.toStringList() ?: emptyList(),
            author = o.optString("author"),
            updatedBy = o.optString("updatedBy"),
            updatedAt = o.optLong("updatedAt"),
            revision = o.optInt("revision", 1),
            deleted = o.has("deleted"),
            score = o.optDouble("score", 0.0),
        )
    }
}

fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

fun JSONArray.toStringList(): List<String> = (0 until length()).map { optString(it) }

/** 日志里安全地截断正文 */
fun String?.preview(limit: Int = 80): String {
    val s = this ?: return ""
    val flat = s.replace(Regex("\\s+"), " ").trim()
    return if (flat.length <= limit) flat else flat.take(limit) + "…"
}

package top.wennie99s.copilot2copilot.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * 连接配置。令牌以明文存在应用私有 DataStore 里（与扩展的 SecretStorage 不同），
 * 自用场景可接受；界面不提供「查看已保存令牌」，只有用户主动输入才写入。
 */
data class C2CConfig(
    val relayUrl: String = "wss://relay.wennie99s.top",
    val id: String = "",
    val role: String = "本人手机",
    val scope: String = "人工查看与转发，不提供 AI 答复",
    val token: String = "",
    val autoConnect: Boolean = true,
) {
    /** 能与中继通信的最小条件（令牌由中继侧决定是否必需） */
    val ready: Boolean get() = relayUrl.isNotBlank() && id.isNotBlank() && role.isNotBlank() && scope.isNotBlank()
}

private val Context.configDataStore: DataStore<Preferences> by preferencesDataStore(name = "c2c_config")

class ConfigStore(private val context: Context) {
    private object Keys {
        val relayUrl = stringPreferencesKey("relayUrl")
        val id = stringPreferencesKey("id")
        val role = stringPreferencesKey("role")
        val scope = stringPreferencesKey("scope")
        val token = stringPreferencesKey("token")
        val autoConnect = booleanPreferencesKey("autoConnect")
    }

    val config: Flow<C2CConfig> = context.configDataStore.data.map { p ->
        C2CConfig(
            relayUrl = p[Keys.relayUrl] ?: C2CConfig().relayUrl,
            id = p[Keys.id] ?: "",
            role = p[Keys.role] ?: C2CConfig().role,
            scope = p[Keys.scope] ?: C2CConfig().scope,
            token = p[Keys.token] ?: "",
            autoConnect = p[Keys.autoConnect] ?: true,
        )
    }

    suspend fun current(): C2CConfig = config.first()

    suspend fun save(cfg: C2CConfig) {
        context.configDataStore.edit { p ->
            p[Keys.relayUrl] = cfg.relayUrl.trim()
            p[Keys.id] = cfg.id.trim()
            p[Keys.role] = cfg.role.trim()
            p[Keys.scope] = cfg.scope.trim()
            p[Keys.token] = cfg.token
            p[Keys.autoConnect] = cfg.autoConnect
        }
    }
}

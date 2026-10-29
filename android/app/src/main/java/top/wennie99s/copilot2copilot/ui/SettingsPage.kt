package top.wennie99s.copilot2copilot.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import top.wennie99s.copilot2copilot.data.C2CConfig
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.vm.C2CViewModel

@Composable
fun SettingsPage(vm: C2CViewModel, modifier: Modifier = Modifier) {
    val state by vm.state.collectAsState()
    val context = LocalContext.current

    var relayUrl by remember { mutableStateOf("") }
    var id by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var scopeText by remember { mutableStateOf("") }
    // 令牌只写不读：已保存的值不回填，留空表示不修改
    var token by remember { mutableStateOf("") }
    var mobileToken by remember { mutableStateOf("") }
    var autoConnect by remember { mutableStateOf(true) }
    var dirty by remember { mutableStateOf(false) }

    // 配置异步加载：未编辑前跟随配置；编辑后不被热更新覆盖（令牌不回填）
    LaunchedEffect(state.config, dirty) {
        if (!dirty) {
            relayUrl = state.config.relayUrl
            id = state.config.id
            role = state.config.role
            scopeText = state.config.scope
            autoConnect = state.config.autoConnect
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    Column(modifier.verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusDot(state.conn.status)
                    Text(
                        when (state.conn.status) {
                            ConnStatus.Online -> "已连接"
                            ConnStatus.Connecting -> "连接中"
                            ConnStatus.Error -> "连接失败"
                            ConnStatus.Disconnected -> "未连接"
                        },
                        style = MaterialTheme.typography.titleSmall,
                    )
                }
                Text(state.conn.detail, style = MaterialTheme.typography.bodySmall)
                if (state.conn.relayVersion.isNotBlank()) {
                    Text("中继版本 ${state.conn.relayVersion}", style = MaterialTheme.typography.labelSmall)
                }
                Text("本机 id：${state.config.id.ifBlank { "（未设置）" }}", style = MaterialTheme.typography.labelSmall)
            }
        }

        OutlinedTextField(
            value = relayUrl,
            onValueChange = { relayUrl = it; dirty = true },
            label = { Text("中继地址") },
            placeholder = { Text("wss://relay.wennie99s.top") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            supportingText = { Text("可只填主机名（默认 wss://）；内网可填 ws://192.168.x.x:8787") },
        )
        OutlinedTextField(
            value = id,
            onValueChange = { id = it; dirty = true },
            label = { Text("本机 id（必填，需与其他设备不同）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = role,
            onValueChange = { role = it; dirty = true },
            label = { Text("角色（同事看到）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = scopeText,
            onValueChange = { scopeText = it; dirty = true },
            label = { Text("负责内容（同事看到）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it; dirty = true },
            label = { Text("中继令牌（可选）") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            supportingText = { Text(if (state.config.token.isNotBlank()) "已保存；留空表示不修改" else "留空表示匿名连接（中继未设令牌时）") },
        )
        OutlinedTextField(
            value = mobileToken,
            onValueChange = { mobileToken = it; dirty = true },
            label = { Text("手机专用令牌（必填）") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            supportingText = {
                Text(
                    if (state.config.mobileToken.isNotBlank()) {
                        "已保存；留空表示不修改。对应中继的 TALK2COPILOT_MOBILE_TOKEN"
                    } else {
                        "对应中继的 TALK2COPILOT_MOBILE_TOKEN；缺失会被中继以 4009 拒绝"
                    },
                )
            },
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("启动时自动连接", style = MaterialTheme.typography.bodyMedium)
                Text("关闭后需要手动点「连接」", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = autoConnect, onCheckedChange = { autoConnect = it; dirty = true })
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    vm.saveAndConnect(
                        C2CConfig(
                            relayUrl = relayUrl,
                            id = id,
                            role = role,
                            scope = scopeText,
                            // 留空表示沿用已保存的令牌
                            token = token.ifBlank { state.config.token },
                            mobileToken = mobileToken.ifBlank { state.config.mobileToken },
                            autoConnect = autoConnect,
                        ),
                    )
                    token = ""
                    mobileToken = ""
                    dirty = false
                },
            ) { Text("保存并连接") }
            OutlinedButton(onClick = { vm.disconnect() }) { Text("断开") }
        }

        HorizontalDivider()

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("通知", style = MaterialTheme.typography.titleSmall)
            Text(
                "后台收到消息时用系统通知提醒。未授予通知权限时只能在应用内查看。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(
                onClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            ) { Text("请求通知权限") }
        }

        HorizontalDivider()

        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("关于", style = MaterialTheme.typography.titleSmall)
            Text("Copilot2Copilot 手机端 0.1.0 · 协议 v7", style = MaterialTheme.typography.bodySmall)
            Text(
                "手机是人工终端：同事能在列表里看到你（标注「手机」），但中继会拒绝向你派发写任务；普通消息照常送达，可手动回复。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun rememberCoroutineScopeSafe() = androidx.compose.runtime.rememberCoroutineScope()

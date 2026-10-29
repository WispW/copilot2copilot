package top.wennie99s.copilot2copilot.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.runtime.collectAsState
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.vm.C2CViewModel

enum class AppTab(val label: String, val icon: ImageVector) {
    Messages("会话", Icons.Outlined.Chat),
    Peers("同事", Icons.Outlined.People),
    Rooms("房间", Icons.Outlined.Groups),
    Memory("记忆", Icons.Outlined.Inventory2),
    Settings("设置", Icons.Outlined.Settings),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun C2CApp(vm: C2CViewModel = viewModel(), initialPeer: String? = null) {
    val state by vm.state.collectAsState()
    var tab by remember { mutableStateOf(AppTab.Messages) }
    var chatPeer by remember { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }

    // 从通知点进来：直接打开对应会话
    LaunchedEffect(initialPeer) {
        if (!initialPeer.isNullOrBlank()) {
            chatPeer = initialPeer
            vm.markRead(initialPeer)
        }
    }

    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }

    // 进入会话或在会话内收到新消息时标记已读（已读状态随历史落盘，重启后不再红点）
    LaunchedEffect(chatPeer, state.messages.size) {
        chatPeer?.let { vm.markRead(it) }
    }

    BackHandler(enabled = chatPeer != null) { chatPeer = null }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            if (chatPeer != null) chatPeer!! else "Copilot2Copilot",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            StatusDot(state.conn.status)
                            Text(
                                when (state.conn.status) {
                                    ConnStatus.Online -> "已连接${if (state.conn.relayVersion.isNotBlank()) " · 中继 ${state.conn.relayVersion}" else ""}"
                                    ConnStatus.Connecting -> state.conn.detail
                                    ConnStatus.Error -> state.conn.detail
                                    ConnStatus.Disconnected -> "未连接"
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        bottomBar = {
            if (chatPeer == null) {
                NavigationBar {
                    AppTab.entries.forEach { item ->
                        val badge = if (item == AppTab.Messages && state.unreadTotal > 0) state.unreadTotal else 0
                        NavigationBarItem(
                            selected = tab == item,
                            onClick = { tab = item },
                            icon = {
                                if (badge > 0) {
                                    androidx.compose.material3.BadgedBox(
                                        badge = { androidx.compose.material3.Badge { Text("$badge") } },
                                    ) { Icon(item.icon, contentDescription = item.label) }
                                } else {
                                    Icon(item.icon, contentDescription = item.label)
                                }
                            },
                            label = { Text(item.label) },
                        )
                    }
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val contentModifier = Modifier
            .padding(padding)
            .fillMaxSize()
        if (chatPeer != null) {
            ChatScreen(vm, chatPeer!!, onBack = { chatPeer = null }, modifier = contentModifier)
        } else {
            when (tab) {
                AppTab.Messages -> MessagesPage(vm, contentModifier, onOpenChat = { chatPeer = it })
                AppTab.Peers -> PeersPage(vm, contentModifier, onOpenChat = { chatPeer = it })
                AppTab.Rooms -> RoomsPage(vm, contentModifier)
                AppTab.Memory -> MemoryPage(vm, contentModifier)
                AppTab.Settings -> SettingsPage(vm, contentModifier)
            }
        }
    }
}

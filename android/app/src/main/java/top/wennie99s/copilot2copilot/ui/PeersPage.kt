package top.wennie99s.copilot2copilot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.vm.C2CViewModel

@Composable
fun PeersPage(vm: C2CViewModel, modifier: Modifier = Modifier, onOpenChat: (String) -> Unit) {
    val state by vm.state.collectAsState()
    val peers = state.peers.values.sortedBy { it.id }

    if (peers.isEmpty()) {
        Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("暂无在线同事", style = MaterialTheme.typography.titleMedium)
                Text(
                    when {
                        state.conn.status != ConnStatus.Online -> "尚未连接中继：先到「设置」页连接"
                        state.rooms.none { it.joined } -> "你还没有加入任何房间——房间决定「谁能看到谁」"
                        else -> "房间里暂时没有其他在线成员，对方上线后会自动出现"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    LazyColumn(modifier) {
        item {
            Card(
                Modifier.fillMaxWidth().padding(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("本机身份：${state.config.id}", style = MaterialTheme.typography.labelLarge)
                    Text(
                        "手机是人工终端：同事能看到你，但不会向你派发写任务。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        items(peers, key = { it.id }) { profile ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onOpenChat(profile.id) }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusDot(ConnStatus.Online)
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(profile.id, style = MaterialTheme.typography.titleSmall)
                        KindBadge(profile)
                    }
                    Text(
                        "角色：${profile.role.ifBlank { "（未填写）" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "负责：${profile.scope.ifBlank { "（未填写）" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            HorizontalDivider()
        }
    }
}

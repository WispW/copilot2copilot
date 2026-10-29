package top.wennie99s.copilot2copilot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.protocol.RoomInfo
import top.wennie99s.copilot2copilot.vm.C2CViewModel

@Composable
fun RoomsPage(vm: C2CViewModel, modifier: Modifier = Modifier) {
    val state by vm.state.collectAsState()
    var joining by remember { mutableStateOf<RoomInfo?>(null) }

    LaunchedEffect(state.conn.status) {
        if (state.conn.status == ConnStatus.Online) vm.refreshRooms()
    }

    if (state.conn.status != ConnStatus.Online) {
        Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            Text("连接中继后才能查看与加入房间", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    val categoryNames = state.categories.associate { it.id to it.name }
    val grouped = state.rooms.groupBy { it.categoryId }

    LazyColumn(modifier) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("房间（${state.rooms.size}）", style = MaterialTheme.typography.titleMedium)
                OutlinedButton(onClick = { vm.refreshRooms() }) { Text("刷新") }
            }
        }
        grouped.forEach { (categoryId, rooms) ->
            item(key = "cat-$categoryId") {
                Text(
                    categoryNames[categoryId] ?: "未分类",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            items(rooms, key = { it.id }) { room ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(room.name, style = MaterialTheme.typography.titleSmall)
                            if (room.hasPassword) Text("🔒", style = MaterialTheme.typography.labelSmall)
                            if (room.joined) Text("已加入", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                        Text(
                            "${room.memberCount} 位成员 · ${room.memoryCount} 条记忆",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (room.joined) {
                        OutlinedButton(onClick = { vm.leaveRoom(room.id) }) { Text("退出") }
                    } else {
                        Button(onClick = { joining = room }) { Text("加入") }
                    }
                }
                HorizontalDivider()
            }
        }
        if (state.rooms.isEmpty()) {
            item {
                Card(
                    Modifier.fillMaxWidth().padding(16.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Text(
                        "还没有房间。房间由中继管理员创建，创建后把名称与密码告诉设备，其他设备在这里凭密码加入。",
                        modifier = Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }

    joining?.let { room ->
        JoinRoomDialog(
            room = room,
            onDismiss = { joining = null },
            onConfirm = { password ->
                vm.joinRoom(room.id, password)
                joining = null
            },
        )
    }
}

@Composable
private fun JoinRoomDialog(room: RoomInfo, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("加入「${room.name}」") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${room.memberCount} 位成员", style = MaterialTheme.typography.bodySmall)
                if (room.hasPassword) {
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("房间密码") },
                        singleLine = true,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(password) }) { Text("加入") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

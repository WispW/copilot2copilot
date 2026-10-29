package top.wennie99s.copilot2copilot.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import top.wennie99s.copilot2copilot.protocol.MemoryItem
import top.wennie99s.copilot2copilot.vm.C2CViewModel

@Composable
fun MemoryPage(vm: C2CViewModel, modifier: Modifier = Modifier) {
    val state by vm.state.collectAsState()
    val joined = state.rooms.filter { it.joined }
    var selectedRoom by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<MemoryItem?>(null) }
    var adding by remember { mutableStateOf(false) }

    LaunchedEffect(joined) {
        if (selectedRoom.isBlank() || joined.none { it.id == selectedRoom }) {
            joined.firstOrNull()?.let {
                selectedRoom = it.id
                vm.openMemory(it.id)
            }
        }
    }

    if (joined.isEmpty()) {
        Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("共享记忆按房间隔离", style = MaterialTheme.typography.titleMedium)
                Text(
                    "记忆只能读写自己加入的房间。先到「房间」页加入房间。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    Column(modifier) {
        LazyRow(
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(joined, key = { it.id }) { room ->
                FilterChip(
                    selected = room.id == selectedRoom,
                    onClick = {
                        selectedRoom = room.id
                        query = ""
                        vm.openMemory(room.id)
                    },
                    label = { Text(room.name) },
                )
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("检索记忆…") },
                singleLine = true,
            )
            IconButton(onClick = { vm.queryMemory(selectedRoom, query) }) {
                Icon(Icons.Default.Search, contentDescription = "检索")
            }
            IconButton(onClick = { adding = true }) {
                Icon(Icons.Default.Add, contentDescription = "新增")
            }
        }

        val mem = state.memory
        when {
            mem.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            mem.entries.isEmpty() -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.TopCenter) {
                Text(
                    mem.error ?: "这个房间还没有记忆。拿到可复用的结论后，用右上角 + 写入。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 24.dp),
                )
            }
            else -> LazyColumn {
                items(mem.entries, key = { it.id }) { entry ->
                    Card(
                        onClick = { editing = entry },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    ) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(entry.text, style = MaterialTheme.typography.bodyMedium)
                            if (entry.tags.isNotEmpty()) {
                                Text(
                                    entry.tags.joinToString(" ") { "#$it" },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                            Text(
                                "${entry.author} · v${entry.revision}${if (entry.score > 0) " · 相关度 ${entry.score}" else ""}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                item { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            }
        }
    }

    if (adding) {
        MemoryEditDialog(
            title = "写入共享记忆",
            initial = "",
            onDismiss = { adding = false },
            onConfirm = { text ->
                vm.remember(selectedRoom, text)
                adding = false
            },
        )
    }

    editing?.let { entry ->
        MemoryEditDialog(
            title = "修改记忆（v${entry.revision}）",
            initial = entry.text,
            onDismiss = { editing = null },
            onConfirm = { text ->
                vm.updateMemory(selectedRoom, entry.id, text, entry.revision)
                editing = null
            },
            onDelete = {
                vm.deleteMemory(selectedRoom, entry.id, entry.revision)
                editing = null
            },
        )
    }
}

@Composable
private fun MemoryEditDialog(
    title: String,
    initial: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    onDelete: (() -> Unit)? = null,
) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
                maxLines = 8,
                label = { Text("内容（一条一个事实，简短明确）") },
            )
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (onDelete != null) {
                    TextButton(onClick = onDelete) {
                        Text("删除", color = MaterialTheme.colorScheme.error)
                    }
                }
                Button(onClick = { onConfirm(text) }, enabled = text.isNotBlank()) { Text("保存") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

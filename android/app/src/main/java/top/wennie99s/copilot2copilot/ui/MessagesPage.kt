package top.wennie99s.copilot2copilot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AssistChip
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.collectAsState
import top.wennie99s.copilot2copilot.data.ChatMessage
import top.wennie99s.copilot2copilot.protocol.Profile
import top.wennie99s.copilot2copilot.vm.C2CViewModel

@Composable
fun MessagesPage(vm: C2CViewModel, modifier: Modifier = Modifier, onOpenChat: (String) -> Unit) {
    val state by vm.state.collectAsState()
    if (state.messages.isEmpty()) {
        Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("还没有会话", style = MaterialTheme.typography.titleMedium)
                Text(
                    when {
                        state.conn.status != top.wennie99s.copilot2copilot.net.ConnStatus.Online -> "先到「设置」填写中继地址并连接"
                        state.rooms.none { it.joined } -> "还没有加入房间：到「房间」页选择房间加入"
                        else -> "到「同事」页选择一位在线同事开始对话"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    val lastByPeer = state.messages.groupBy { it.peerId }.mapValues { (_, list) -> list.maxByOrNull { it.ts } }
    val rows = lastByPeer.entries.sortedByDescending { it.value?.ts ?: 0L }

    LazyColumn(modifier) {
        items(rows, key = { it.key }) { entry ->
            val peerId = entry.key
            val last = entry.value
            val profile = state.peers[peerId] ?: Profile(peerId, "", "")
            PeerRow(
                profile = profile,
                lastText = last?.let { (if (it.direction == "out") "我：" else "") + it.text },
                unread = state.unreadByPeer[peerId] ?: 0,
                onClick = { onOpenChat(peerId) },
            )
            HorizontalDivider()
        }
    }
}

@Composable
fun ChatScreen(vm: C2CViewModel, peerId: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state by vm.state.collectAsState()
    val messages = remember(state.messages, peerId) {
        state.messages.filter { it.peerId == peerId }.sortedBy { it.ts }
    }
    var input by remember { mutableStateOf("") }
    var replyTo by remember { mutableStateOf<ChatMessage?>(null) }
    var asTask by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    val send: () -> Unit = {
        val text = input.trim()
        if (text.isNotEmpty()) {
            val target = replyTo
            if (target != null) {
                vm.reply(peerId, target.requestId ?: target.id, text)
            } else {
                vm.sendMessage(peerId, text, if (asTask) "task" else "ask")
            }
            input = ""
            replyTo = null
            // 保持「写任务 / 问信息」的选择：发送后自动复位容易让人以为仍在写任务模式下
            // 结果发出去的是只读消息（气泡上有「写任务」标记，误发也能一眼看出）
        }
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Column(modifier.imePadding()) {
        // 同事档案
        val profile = state.peers[peerId]
        if (profile != null) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusDot(top.wennie99s.copilot2copilot.net.ConnStatus.Online)
                    Text(profile.role.ifBlank { peerId }, style = MaterialTheme.typography.labelLarge)
                    KindBadge(profile)
                }
                if (profile.scope.isNotBlank()) {
                    Text(profile.scope, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            HorizontalDivider()
        }

        LazyColumn(state = listState, modifier = Modifier.weight(1f).fillMaxWidth()) {
            items(messages, key = { it.id }) { msg ->
                Bubble(msg, onReply = { replyTo = msg })
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        replyTo?.let { target ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "回复：${target.text.take(40)}",
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                IconButton(onClick = { replyTo = null }) {
                    Icon(Icons.Default.Close, contentDescription = "取消回复")
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (replyTo == null) {
                FilterChip(
                    selected = asTask,
                    onClick = { asTask = !asTask },
                    label = { Text(if (asTask) "写任务" else "问信息") },
                )
            }
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text(if (replyTo != null) "输入回复…" else "输入消息…") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
            )
            IconButton(
                onClick = { send() },
                enabled = input.isNotBlank(),
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
            }
        }
    }
}

@Composable
private fun Bubble(msg: ChatMessage, onReply: () -> Unit) {
    val mine = msg.direction == "out"
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .background(
                    if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(12.dp),
                )
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            if (msg.intent == "task") {
                Text("写任务", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
            MarkdownText(msg.text)
            msg.snippet?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(6.dp))
                        .padding(6.dp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    formatTime(msg.ts),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!mine && !msg.done) {
                    TextButton(onClick = onReply, modifier = Modifier.height(28.dp)) {
                        Text("回复", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

private fun formatTime(ts: Long): String {
    if (ts <= 0) return ""
    val now = System.currentTimeMillis()
    val d = (now - ts) / 86_400_000L
    val hm = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(ts))
    return when {
        d <= 0L -> hm
        d == 1L -> "昨天 $hm"
        else -> java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(ts))
    }
}

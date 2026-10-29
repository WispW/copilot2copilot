package top.wennie99s.copilot2copilot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import top.wennie99s.copilot2copilot.net.ConnStatus
import top.wennie99s.copilot2copilot.protocol.Profile

@Composable
fun StatusDot(status: ConnStatus, modifier: Modifier = Modifier) {
    val color = when (status) {
        ConnStatus.Online -> Color(0xFF16A34A)
        ConnStatus.Connecting -> Color(0xFFF59E0B)
        ConnStatus.Error -> MaterialTheme.colorScheme.error
        ConnStatus.Disconnected -> MaterialTheme.colorScheme.outline
    }
    Box(
        modifier = modifier
            .background(color = color, shape = RoundedCornerShape(50))
            .padding(4.dp),
    )
}

@Composable
fun KindBadge(profile: Profile) {
    val (text, color) = when (profile.kind) {
        "mobile" -> "📱 手机" to MaterialTheme.colorScheme.secondaryContainer
        "dsh" -> "DSH" to MaterialTheme.colorScheme.tertiaryContainer
        else -> return
    }
    Box(
        modifier = Modifier
            .background(color, RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
fun PeerRow(profile: Profile, lastText: String?, unread: Int, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StatusDot(ConnStatus.Online)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(profile.id, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                KindBadge(profile)
            }
            Text(
                lastText ?: listOf(profile.role, profile.scope).filter { it.isNotBlank() }.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (unread > 0) {
            Box(
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.error, RoundedCornerShape(50))
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            ) {
                Text("$unread", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onError)
            }
        }
    }
}

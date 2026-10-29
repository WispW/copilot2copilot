package top.wennie99s.copilot2copilot

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import top.wennie99s.copilot2copilot.service.RelayService
import top.wennie99s.copilot2copilot.ui.C2CApp
import top.wennie99s.copilot2copilot.ui.theme.C2CTheme
import top.wennie99s.copilot2copilot.vm.C2CViewModel

class MainActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PEER = "extra_peer"
    }

    private val vm: C2CViewModel by viewModels()
    private var pendingPeer by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingPeer = intent.getStringExtra(EXTRA_PEER)
        setContent {
            C2CTheme {
                C2CApp(vm = vm, initialPeer = pendingPeer)
            }
        }
        // 前台服务保活长连接（Android 8+ 必须显式启动）
        runCatching { ContextCompat.startForegroundService(this, Intent(this, RelayService::class.java)) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingPeer = intent.getStringExtra(EXTRA_PEER)
    }

    override fun onResume() {
        super.onResume()
        vm.appVisible = true
    }

    override fun onPause() {
        vm.appVisible = false
        super.onPause()
    }
}

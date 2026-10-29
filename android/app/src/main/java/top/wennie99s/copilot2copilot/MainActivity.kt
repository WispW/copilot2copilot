package top.wennie99s.copilot2copilot

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
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
        requestNotificationPermissionIfNeeded()
    }

    /** Android 13+ 必须显式申请通知权限，否则未读通知会静默不显示 */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingPeer = intent.getStringExtra(EXTRA_PEER)
    }

    override fun onResume() {
        super.onResume()
        vm.setAppVisible(true)
    }

    override fun onPause() {
        vm.setAppVisible(false)
        super.onPause()
    }
}

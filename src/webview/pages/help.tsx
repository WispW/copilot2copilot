import { Hint, Section } from '../components';
import type { Snapshot } from '../state';

export function HelpPage({ snap }: { snap: Snapshot }) {
  const loop = snap.state?.loopGuard ?? { windowMs: 300_000, limit: 10 };
  return (
    <div>
      <Section title="连接与重连">
        <Hint>
          扩展只在两种时机向中继发起连接：<strong>VS Code 启动时自动一次</strong>（可在「连接」页关掉），
          以及<strong>你点「连接 / 重试连接」时</strong>。任何断开（含中继未启动、地址或令牌错误、被踢出、被封禁、网络抖动）
          都会停在「连接失败 / 未连接」状态并给出原因，<strong>不会自动重连</strong>，也不会在后台反复发起请求。
        </Hint>
        <Hint>断开期间：本机 Copilot 的沟通工具会提示"通道未连接"；点「连接」即可恢复，未发出的消息会在连上后补发。</Hint>
      </Section>

      <Section title="聊天边界">
        <Hint>
          中继只是转发通道，双方的消息直达对方本机 Copilot 对话。通信约定为<strong>只读查询</strong>：
          可以问信息、请对方解释代码事实，但不能要求对方修改代码 / 文件 / 配置，也不能要求执行有副作用的操作
          （写入、安装、部署、重启等）。该约定随消息一起注入对方 Copilot。
        </Hint>
      </Section>

      <Section title="房间（可见域）">
        <Hint>
          房间决定「谁能看到谁」：设备只能看到、也只能与同房间成员通信；<strong>没有共同房间时与对方互相不可见</strong>，
          连列表里都不会出现。一个设备可以同时加入多个房间，可见范围是这些房间成员的并集。中继会强制校验共同房间，管理员也不例外。
        </Hint>
        <Hint>
          房间由创建者（所有者）管理：改名、改密码（密码即加入口令）、移出成员、解散。
          被移出的成员进入该房间的禁止名单，不能凭密码重新加入，需所有者或管理员解除。
        </Hint>
      </Section>

      <Section title="两套「移出」与「封禁」的区别">
        <Hint>
          <strong>移出房间</strong>：只影响某个房间的可见性，对方仍在中继上、可能与你在其他共同房间里通信；可在「管理 → 房间移出名单」解除。
          <strong>踢出中继</strong>：断开对方与中继的连接，对方可再次连接（点「重试连接」）。
          <strong>封禁</strong>：断开且拒绝再接入，需管理员在「管理 → 中继封禁名单」解封；解封后对方需手动重连（不会自动）。
        </Hint>
      </Section>

      <Section title="令牌与版本">
        <Hint>
          中继令牌、中继管理令牌都保存在系统密钥库（SecretStorage），不写进配置文件；界面里留空表示保持不变。
          管理令牌对应中继侧的环境变量 TALK2COPILOT_ADMIN_TOKEN，中继未配置时管理功能整体不可用。
        </Hint>
        <Hint>
          版本门禁：扩展版本必须与中继的运行版本一致，否则中继以 4008 拒绝接入（测试包版本号如 0.4.2-test1 会被忽略后缀）。
          两端扩展也需与中继同步升级。
        </Hint>
      </Section>

      <Section title="熔断与文件">
        <Hint>
          与同一位同事在 {loop.windowMs / 60000} 分钟内的往来达到 {loop.limit} 条会自动中止，避免两端 Copilot 无限对话；
          可在「行为」页重置计数，或等窗口滑过后自动恢复。
        </Hint>
        <Hint>
          文件交接走独立通道（不经双方模型），512 KiB 分块、逐块确认、整文件 sha256 校验，单文件上限 64 MiB；
          收下的文件放在扩展私有目录（「收件箱」页可打开），不进入工作区。发送要求对方同时在线，不会排队补发。
        </Hint>
      </Section>
    </div>
  );
}

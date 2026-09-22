import { CopyButton, Hint, Section } from '../components';
import { post } from '../api';
import { updateDraft, updateIdentity, updateTokens, type Snapshot } from '../state';

const STATE_LABEL: Record<string, string> = {
  stopped: '未连接',
  connecting: '连接中',
  online: '已连接',
  offline: '连接失败',
};

export function ConnectPage({ snap }: { snap: Snapshot }) {
  const state = snap.state;
  if (!state) {
    return null;
  }
  const status = state.status;
  const relay = state.relayInfo;
  const mine = state.extensionVersion;
  const mismatch = Boolean(relay.version && mine && relay.version !== mine);
  const myId = state.effectiveIdentity.id || '';
  const missing = state.identityMissing;
  const hasWorkspace = Boolean(state.workspaceLabel);

  return (
    <div>
      <Section title="连接状态">
        <div class="status-line">
          <span class={`dot ${status.state}`}></span>
          <b>{STATE_LABEL[status.state] ?? status.state}</b>
          <span class="hint">{status.detail}</span>
          {status.state === 'offline' && (
            <button class="primary small" onClick={() => post({ type: 'connect' })}>重试连接</button>
          )}
        </div>
        <div class="kv">
          <div><span class="k">本机 id</span><span class="v">{myId || '（未填写）'}</span>{myId && <CopyButton text={myId} />}</div>
          <div><span class="k">中继地址</span><span class="v">{state.config.relay.url || '（未填写）'}</span></div>
          <div><span class="k">在线 Copilot</span><span class="v">{state.onlineIds.length} 位</span></div>
          <div><span class="k">中继版本</span><span class="v">{relay.version ? `${relay.version}（协议 ${relay.protocol}）` : '连接成功后显示'}</span></div>
          <div><span class="k">扩展版本</span><span class="v">{mine || '未知'}</span></div>
        </div>
        {mismatch
          ? <div class="banner">扩展版本（{mine}）与中继版本（{relay.version}）不一致，中继会拒绝接入。请把扩展与中继升到同一版本。</div>
          : <Hint>扩展与中继版本必须一致，否则中继拒绝接入（同一版本号、测试包除外）。</Hint>}
        <Hint>
          连接只在两种时机发起：启动 VS Code 时自动一次（可在下面关掉），以及你点「连接 / 重试连接」时。
          <strong>断开后不会自动重连</strong>，需要手动再点一次。
        </Hint>
      </Section>

      <Section title="中继服务器">
        <label>
          中继地址
          <input
            value={snap.draft.relayUrl}
            placeholder="wss://relay.example.com"
            onInput={e => updateDraft({ relayUrl: e.currentTarget.value })}
          />
        </label>
        <label>
          中继令牌（可选）
          <input
            type="password"
            value={snap.tokens.token}
            placeholder="留空表示保持不变"
            onInput={e => updateTokens({ token: e.currentTarget.value })}
          />
        </label>
        <label>
          中继管理令牌（可选）
          <input
            type="password"
            value={snap.tokens.adminToken}
            placeholder="留空表示保持不变"
            onInput={e => updateTokens({ adminToken: e.currentTarget.value })}
          />
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked={snap.draft.autoConnect}
            onChange={e => updateDraft({ autoConnect: e.currentTarget.checked })}
          />
          启动 VS Code 时自动连接一次
        </label>
        <Hint>
          令牌保存在系统密钥库（SecretStorage），不会写进配置文件；改动后需点右上角「保存并应用」。
          管理令牌用于获得中继管理权限（查看 / 踢出 / 封禁在线设备，并对所有房间拥有所有者权限）。
        </Hint>
      </Section>

      <Section title="我的档案（本工作区）">
        {missing.length > 0 && (
          <div class="banner">请先补全档案：缺少 {missing.join('、')}，未完成前无法与同事通信。</div>
        )}
        <Hint>
          当前工作区：{hasWorkspace ? state.workspaceLabel : '（未打开工作区，档案仍随本窗口保存）'}。
          档案按窗口独立保存，因此本机多个窗口不会在中继上互相顶下线。
        </Hint>
        <div class="grid">
          <label>
            id
            <input
              value={snap.identity.id}
              placeholder="唯一标识，需与同事约定一致"
              onInput={e => updateIdentity({ id: e.currentTarget.value })}
            />
          </label>
          <label>
            角色
            <input
              value={snap.identity.role}
              placeholder="如：后端工程师"
              onInput={e => updateIdentity({ role: e.currentTarget.value })}
            />
          </label>
          <label>
            负责内容
            <input
              value={snap.identity.scope}
              placeholder="如：订单服务、支付网关"
              onInput={e => updateIdentity({ scope: e.currentTarget.value })}
            />
          </label>
        </div>
        <Hint>把 id 告诉同事即可——双方的档案会经中继自动互相同步，不需要手工登记。</Hint>
      </Section>
    </div>
  );
}

import { Hint, Section } from '../components';
import { post } from '../api';
import type { Snapshot } from '../state';

function formatSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) {
    return `${n} 字节`;
  }
  if (n < 1048576) {
    return `${(n / 1024).toFixed(1)} KiB`;
  }
  return `${(n / 1048576).toFixed(2)} MiB`;
}

export function InboxPage({ snap }: { snap: Snapshot }) {
  const messages = snap.state?.messages ?? [];
  return (
    <Section title="收件箱" extra={<button onClick={() => post({ type: 'openFilesDir' })}>打开收件目录</button>}>
      <Hint>同事发来的文件保存在扩展私有目录（不进入工作区），点上面的按钮可在文件管理器中打开。</Hint>
      {messages.length === 0 && <p class="hint">暂无消息。</p>}
      {messages.map(m => {
        const dir = m.direction === 'in' ? '收到' : '发出';
        const status = m.done
          ? (m.direction === 'in' ? '已回复' : '已收到回复')
          : (m.direction === 'in' ? '未回复' : '等待回复');
        return (
          <div class={`msg ${m.direction}`} key={m.id}>
            <div class="msg-head">
              <span class="badge">{dir}</span>
              <b>{m.peerId}</b>
              <span class="hint">{new Date(m.ts).toLocaleString()} · {status} · {m.id}</span>
            </div>
            {m.text && <pre class="body">{m.text}</pre>}
            {m.file && (
              <div class="file">
                文件：<b>{m.file.name}</b>（{formatSize(m.file.size)}，sha256 {String(m.file.sha256 || '').slice(0, 12)}…）
                {m.direction === 'in' && m.file.path && <><br />已保存到：<code>{m.file.path}</code></>}
              </div>
            )}
            {m.snippet && (
              <details>
                <summary>代码片段</summary>
                <pre class="body">{m.snippet}</pre>
              </details>
            )}
            {m.direction === 'out' && m.replyText && <div class="reply">对方回复：{m.replyText}</div>}
          </div>
        );
      })}
    </Section>
  );
}

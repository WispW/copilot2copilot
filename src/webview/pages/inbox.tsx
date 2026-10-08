import { Fragment } from 'preact';
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
      {messages.length > 0 && (
        <div class="chat">
          {messages.map(m => {
            const status = m.done
              ? (m.direction === 'in' ? '已回复' : '已收到回复')
              : (m.direction === 'in' ? '未回复' : '等待回复');
            return (
              <Fragment key={m.id}>
                <div class={`chat-row ${m.direction}`}>
                  <div class={`bubble ${m.direction}`}>
                    <div class="bubble-meta">
                      <b>{m.peerId}</b>
                      <span>{new Date(m.ts).toLocaleString()}</span>
                      <span>{status}</span>
                      <span class="bubble-id">{m.id}</span>
                    </div>
                    {m.text && <div class="bubble-text">{m.text}</div>}
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
                  </div>
                </div>
                {m.direction === 'out' && m.replyText && (
                  <div class="chat-row in">
                    <div class="bubble in">
                      <div class="bubble-meta">
                        <b>{m.peerId}</b>
                        <span>回复</span>
                        <span class="bubble-id">{m.id}</span>
                      </div>
                      <div class="bubble-text">{m.replyText}</div>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </Section>
  );
}

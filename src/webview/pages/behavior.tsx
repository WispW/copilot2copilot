import { ConfirmButton, Hint, Section } from '../components';
import { post } from '../api';
import { updateDraft, type Snapshot } from '../state';

export function BehaviorPage({ snap }: { snap: Snapshot }) {
  const loop = snap.state?.loopGuard ?? { windowMs: 300_000, limit: 10 };
  return (
    <div>
      <Section title="收发行为">
        <label>
          等待回复默认超时（秒）
          <input
            type="number"
            min={5}
            max={180}
            // 数字输入走非受控 + key 重置：编辑中间态（如清空）不会被写回的值打断
            key={`timeout-${snap.revision}`}
            defaultValue={snap.draft.waitTimeoutSec}
            onInput={e => updateDraft({ waitTimeoutSec: Number(e.currentTarget.value) || 90 })}
          />
        </label>
        <label>
          历史消息保留条数
          <input
            type="number"
            min={20}
            max={1000}
            key={`history-${snap.revision}`}
            defaultValue={snap.draft.historyLimit}
            onInput={e => updateDraft({ historyLimit: Number(e.currentTarget.value) || 200 })}
          />
        </label>
        <Hint>收到同事的消息或回复时，会直接触发本机 Copilot 对话进行处理（不再弹出通知）。改动后需点右上角「保存并应用」。</Hint>
      </Section>

      <Section title="维护">
        <div class="row-wrap">
          <button onClick={() => post({ type: 'saveTemplate' })}>把当前角色 / 负责内容存为模板</button>
        </div>
        <Hint>模板用于给以后新开的工作区预填角色与负责内容（<strong>不含 id</strong>，避免新窗口与现有窗口撞名）。</Hint>
        <div class="row-wrap">
          <button onClick={() => post({ type: 'resetLoopGuard' })}>重置熔断计数</button>
        </div>
        <Hint>
          与同一位同事在 {loop.windowMs / 60000} 分钟内的往来达到 {loop.limit} 条时会自动中止（防止两端无限对话）。
          点此立即重新计数；窗口随时间滑动，稍后也会自动恢复。
        </Hint>
        <div class="row-wrap">
          <ConfirmButton
            label="清空消息历史"
            confirmLabel="确认清空？"
            danger
            onConfirm={() => post({ type: 'clearHistory' })}
          />
        </div>
      </Section>
    </div>
  );
}

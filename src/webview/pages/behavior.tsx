import { ConfirmButton, Hint, Section } from '../components';
import { post } from '../api';
import { updateDraft, type Snapshot } from '../state';

export function BehaviorPage({ snap }: { snap: Snapshot }) {
  return (
    <div class="page">
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
        <label class="row" title="写任务开始 / 结束时用系统通知提醒（关闭只是静音，留痕不受影响）">
          <input
            type="checkbox"
            checked={snap.state?.config.behavior.notify !== false}
            onChange={e => post({ type: 'setNotify', value: e.currentTarget.checked })}
          />
          写任务开始 / 结束时发系统通知
        </label>
      </Section>

      <Section title="维护">
        <div class="row-wrap">
          <button onClick={() => post({ type: 'cancelAllExecGrants' })}>取消所有写授权</button>
        </div>
        <Hint>取消后，所有同事都只能进行只读问答；需要重新授权时到「Copilot 列表」逐人打开「可执行」。</Hint>
        <div class="row-wrap">
          <button onClick={() => post({ type: 'saveTemplate' })}>把当前角色 / 负责内容存为模板</button>
        </div>
        <Hint>模板用于给以后新开的工作区预填角色与负责内容（<strong>不含 id</strong>，避免新窗口与现有窗口撞名）。</Hint>
        <div class="row-wrap">
          <ConfirmButton
            label="清空消息历史"
            confirmLabel="确认清空？"
            danger
            large
            onConfirm={() => post({ type: 'clearHistory' })}
          />
        </div>
      </Section>
    </div>
  );
}

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { post } from './api';

/** 页面区块：统一卡片外观，标题右侧可放操作按钮 */
export function Section({ title, extra, children }: {
  title: string;
  extra?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="card">
      <div class="card-head">
        <h2>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function Hint({ children }: { children: ComponentChildren }) {
  return <p class="hint">{children}</p>;
}

export function Chip({ children, mine }: { children: ComponentChildren; mine?: boolean }) {
  return <span class={mine ? 'chip me' : 'chip'}>{children}</span>;
}

/** 把文本写入系统剪贴板；webview 里 execCommand 比 navigator.clipboard 更可靠 */
function copyText(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      class="small"
      disabled={!text}
      onClick={() => {
        if (copyText(text)) {
          setCopied(true);
        } else {
          post({ type: 'uiHint', message: '无法自动复制，请手动选中文本复制' });
        }
      }}
    >{copied ? '已复制' : label}</button>
  );
}

/**
 * 危险操作的两步确认：VS Code webview 的沙箱会忽略原生 confirm()（静默返回 false），
 * 会让按钮"点了没反应"，因此改成"再点一次确认"；8 秒未确认自动复位。
 */
export function ConfirmButton({ label, confirmLabel, danger, onConfirm }: {
  label: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), 8000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      class={`small${danger ? ' danger' : ''}${armed ? ' armed' : ''}`}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >{armed ? confirmLabel : label}</button>
  );
}

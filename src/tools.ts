import * as vscode from 'vscode';
import { log } from './logger';
import { makeEnvelope, MessageEnvelope } from './protocol';
import { Store } from './store';
import { Transport } from './transport/types';

function json(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))]);
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/** 等待某条消息的回复：由注入器在收到 reply 时唤醒 */
export class ReplyWaiter {
  private readonly waiters = new Map<string, (env: MessageEnvelope) => void>();

  waitFor(id: string, timeoutMs: number, token?: vscode.CancellationToken): Promise<MessageEnvelope | undefined> {
    return new Promise<MessageEnvelope | undefined>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sub: vscode.Disposable | undefined;
      const waiter = (env?: MessageEnvelope) => {
        if (settled) {
          return;
        }
        settled = true;
        // 仅当自己仍是最新的注册者时才移除，避免误删后注册的等待者
        if (this.waiters.get(id) === waiter) {
          this.waiters.delete(id);
        }
        if (timer) {
          clearTimeout(timer);
        }
        sub?.dispose();
        resolve(env);
      };
      timer = setTimeout(() => waiter(undefined), Math.max(timeoutMs, 1000));
      sub = token?.onCancellationRequested(() => waiter(undefined));
      this.waiters.set(id, waiter);
    });
  }

  /** 收到 reply 时调用；命中等待中的请求则返回 true */
  resolve(env: MessageEnvelope): boolean {
    if (env.kind !== 'reply' || !env.requestId) {
      return false;
    }
    const waiter = this.waiters.get(env.requestId);
    if (!waiter) {
      return false;
    }
    this.waiters.delete(env.requestId);
    waiter(env);
    return true;
  }
}

export interface ToolDeps {
  store: Store;
  waiters: ReplyWaiter;
  getTransport(): Transport | undefined;
}

interface SendInput {
  to?: string;
  message: string;
  snippet?: string;
  snippet_language?: string;
  wait_seconds?: number;
}

export class SendMessageTool implements vscode.LanguageModelTool<SendInput> {
  constructor(private readonly deps: ToolDeps) {}

  async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SendInput>): Promise<vscode.PreparedToolInvocation> {
    const colleague = this.deps.store.findColleague(options.input.to);
    const target = colleague ? `${colleague.id}（${colleague.role || '档案未同步'}）` : '未配置的沟通方';
    const body = truncate(options.input.message);
    const code = options.input.snippet
      ? `\n\n\`\`\`${options.input.snippet_language ?? ''}\n${truncate(options.input.snippet)}\n\`\`\``
      : '';
    return {
      invocationMessage: `正在向 ${colleague?.id ?? '沟通方'} 发送消息`,
      confirmationMessages: {
        title: '向同事发送消息',
        message: new vscode.MarkdownString(`将以下内容发送给 **${target}**：\n\n---\n\n${body}${code}`),
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<SendInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const { store, waiters, getTransport } = this.deps;
    const input = options.input;
    const transport = getTransport();
    if (!transport) {
      throw new Error('通信通道未启动。请打开 Talk2Copilot 配置界面检查模式与连接设置。');
    }
    const identity = store.config.identity;
    const missingSelf = store.missingIdentityFields();
    if (missingSelf.length > 0) {
      throw new Error(`你的档案尚未完善（缺少：${missingSelf.join('、')}），暂不能通信。请打开 Talk2Copilot 配置界面补全“我的档案”。`);
    }
    const colleague = store.findColleague(input.to);
    if (!colleague) {
      throw new Error(store.config.colleagues.length === 0
        ? '尚未配置任何沟通方，请先在 Talk2Copilot 配置界面添加同事。'
        : `找不到沟通方 “${input.to}”。请先调用 talk2copilot_list_colleagues 查看可用名单。`);
    }
    if (!store.hasPeerProfile(colleague)) {
      throw new Error(`尚未同步到同事 ${colleague.id} 的档案（角色/负责内容），暂不能通信。请确认对方已完善自己的档案并保持连接（可在配置界面点击该沟通方的“连接”按钮）；同步成功后即可发送。`);
    }

    log(`[tool] send_message → ${colleague.id}（等待=${input.wait_seconds ?? 0}s，片段=${input.snippet ? '有' : '无'}）`);
    const env = makeEnvelope({
      kind: 'message',
      from: identity.id,
      to: colleague.id,
      text: input.message,
      snippet: input.snippet,
      snippetLanguage: input.snippet_language,
      profile: identity,
    });
    const reachable = transport.isOnline(colleague.id);
    await transport.send(env);
    await store.appendMessage({
      id: env.id,
      direction: 'out',
      peerId: colleague.id,
      text: input.message,
      snippet: input.snippet,
      snippetLanguage: input.snippet_language,
      ts: env.ts,
      done: false,
    });

    const waitSec = Math.min(Math.max(input.wait_seconds ?? 0, 0), 120);
    if (waitSec <= 0) {
      return json({
        status: reachable ? 'sent' : 'queued',
        request_id: env.id,
        target: colleague.id,
        hint: reachable
          ? '对方回复后可用 talk2copilot_wait_reply 获取，或查看收件箱。'
          : '对方当前离线，消息已在本机排队，待其上线后自动重发。',
      });
    }
    const reply = await waiters.waitFor(env.id, waitSec * 1000, token);
    if (!reply) {
      return json({
        status: 'pending',
        request_id: env.id,
        target: colleague.id,
        hint: reachable
          ? `已等待 ${waitSec} 秒仍未收到回复，可稍后用 talk2copilot_wait_reply 继续等待。`
          : `对方当前离线（消息已排队），等待 ${waitSec} 秒未收到回复。`,
      });
    }
    return json({
      status: 'ok',
      request_id: env.id,
      target: colleague.id,
      reply: reply.text,
      reply_snippet: reply.snippet,
      reply_snippet_language: reply.snippetLanguage,
    });
  }
}

interface WaitReplyInput {
  request_id: string;
  timeout_seconds?: number;
}

export class WaitReplyTool implements vscode.LanguageModelTool<WaitReplyInput> {
  constructor(private readonly deps: ToolDeps) {}

  async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WaitReplyInput>): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: '等待同事回复',
      confirmationMessages: {
        title: '等待同事回复',
        message: `等待消息 ${options.input.request_id} 的回复。`,
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<WaitReplyInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const { store, waiters } = this.deps;
    const input = options.input;
    const record = store.findMessage(input.request_id);
    if (!record || record.direction !== 'out') {
      throw new Error(`找不到编号为 ${input.request_id} 的已发送消息，请核对 request_id。`);
    }
    if (record.done) {
      return json({ status: 'ok', request_id: input.request_id, reply: record.replyText });
    }
    const defaultSec = store.config.behavior.waitTimeoutSec;
    const waitSec = Math.min(Math.max(input.timeout_seconds ?? defaultSec, 1), 180);
    const reply = await waiters.waitFor(input.request_id, waitSec * 1000, token);
    if (!reply) {
      return json({ status: 'pending', request_id: input.request_id, hint: `已等待 ${waitSec} 秒，仍未收到回复。` });
    }
    return json({
      status: 'ok',
      request_id: input.request_id,
      reply: reply.text,
      reply_snippet: reply.snippet,
      reply_snippet_language: reply.snippetLanguage,
    });
  }
}

interface ReplyInput {
  request_id: string;
  message: string;
  snippet?: string;
  snippet_language?: string;
}

export class ReplyMessageTool implements vscode.LanguageModelTool<ReplyInput> {
  constructor(private readonly deps: ToolDeps) {}

  async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReplyInput>): Promise<vscode.PreparedToolInvocation> {
    const record = this.deps.store.findMessage(options.input.request_id);
    const to = record ? `给 ${record.peerId}` : '给同事';
    return {
      invocationMessage: `正在${to}回复`,
      confirmationMessages: {
        title: '回复同事消息',
        message: new vscode.MarkdownString(
          `回复 ${record?.peerId ?? ''}（${options.input.request_id}）：\n\n---\n\n${truncate(options.input.message)}` +
          (options.input.snippet ? `\n\n\`\`\`${options.input.snippet_language ?? ''}\n${truncate(options.input.snippet)}\n\`\`\`` : '')
        ),
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ReplyInput>): Promise<vscode.LanguageModelToolResult> {
    const { store, getTransport } = this.deps;
    const input = options.input;
    const transport = getTransport();
    if (!transport) {
      throw new Error('通信通道未启动。请打开 Talk2Copilot 配置界面检查模式与连接设置。');
    }
    const missingSelf = store.missingIdentityFields();
    if (missingSelf.length > 0) {
      throw new Error(`你的档案尚未完善（缺少：${missingSelf.join('、')}），暂不能通信。请打开 Talk2Copilot 配置界面补全“我的档案”。`);
    }
    const original = store.findMessage(input.request_id);
    if (!original || original.direction !== 'in') {
      throw new Error(`找不到编号为 ${input.request_id} 的同事消息（或该消息不是你收到的）。请用 talk2copilot_list_inbox 核对。`);
    }
    const colleague = store.findColleague(original.peerId);
    if (!colleague || !store.hasPeerProfile(colleague)) {
      throw new Error(`对方（${original.peerId}）的档案尚未同步（角色/负责内容），暂不能回复。请确认对方已完善档案并保持连接。`);
    }
    log(`[tool] reply_message → ${original.peerId}（request_id=${input.request_id}）`);
    const env = makeEnvelope({
      kind: 'reply',
      from: store.config.identity.id,
      to: original.peerId,
      requestId: input.request_id,
      text: input.message,
      snippet: input.snippet,
      snippetLanguage: input.snippet_language,
      profile: store.config.identity,
    });
    await transport.send(env);
    await store.markDone(input.request_id, input.message);
    return json({ status: 'ok', request_id: input.request_id, target: original.peerId });
  }
}

export class ListColleaguesTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly deps: ToolDeps) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const { store, getTransport } = this.deps;
    const transport = getTransport();
    const colleagues = store.config.colleagues.map(c => ({
      id: c.id,
      role: c.role,
      scope: c.scope,
      online: transport?.isOnline(c.id) ?? false,
      profile_ready: store.hasPeerProfile(c),
    }));
    return json({
      mode: store.config.mode === 'relay' ? '中继' : '局域网',
      my_id: store.config.identity.id,
      colleagues,
      ...(colleagues.length === 0 ? { note: '尚未配置沟通方，请先在 Talk2Copilot 配置界面添加同事。' } : {}),
    });
  }
}

interface InboxInput {
  unread_only?: boolean;
}

export class ListInboxTool implements vscode.LanguageModelTool<InboxInput> {
  constructor(private readonly deps: ToolDeps) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<InboxInput>): Promise<vscode.LanguageModelToolResult> {
    const { store } = this.deps;
    const unreadOnly = options.input.unread_only === true;
    const items = store
      .listMessages(50)
      .filter(i => i.direction === 'in' && (!unreadOnly || !i.done))
      .slice(0, 20)
      .map(i => ({
        request_id: i.id,
        from: i.peerId,
        text: truncate(i.text, 2000),
        has_snippet: Boolean(i.snippet),
        replied: i.done,
        time: new Date(i.ts).toLocaleString(),
      }));
    return json({ unread_only: unreadOnly, count: items.length, messages: items });
  }
}

export function registerTools(context: vscode.ExtensionContext, deps: ToolDeps): void {
  context.subscriptions.push(
    vscode.lm.registerTool('talk2copilot_list_colleagues', new ListColleaguesTool(deps)),
    vscode.lm.registerTool('talk2copilot_send_message', new SendMessageTool(deps)),
    vscode.lm.registerTool('talk2copilot_wait_reply', new WaitReplyTool(deps)),
    vscode.lm.registerTool('talk2copilot_reply_message', new ReplyMessageTool(deps)),
    vscode.lm.registerTool('talk2copilot_list_inbox', new ListInboxTool(deps)),
  );
}

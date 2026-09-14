import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileHub } from './files';
import { log } from './logger';
import { makeEnvelope, MessageEnvelope } from './protocol';
import { colleagueEnabled, LOOP_MESSAGE_LIMIT, LOOP_WINDOW_MS, Store } from './store';
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
  fileHub: FileHub;
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
        message: new vscode.MarkdownString(
          `将以下内容发送给 **${target}**（对方只会提供信息，不会修改其代码或环境）：\n\n---\n\n${body}${code}`,
        ),
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<SendInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const { store, waiters, getTransport } = this.deps;
    const input = options.input;
    const transport = getTransport();
    if (!transport) {
      throw new Error('通信通道未启动。请打开 Copilot2Copilot 配置界面检查中继地址与连接状态。');
    }
    const identity = store.config.identity;
    const missingSelf = store.missingIdentityFields();
    if (missingSelf.length > 0) {
      throw new Error(`你的档案尚未完善（缺少：${missingSelf.join('、')}），暂不能通信。请打开 Copilot2Copilot 配置界面补全“我的档案”。`);
    }
    if (input.to && input.to === store.config.identity.id) {
      throw new Error('不能给自己发送消息：to 要填对方的 id（你自己的 id 不会出现在 Copilot 列表里）。');
    }
    const colleague = store.findColleague(input.to);
    if (!colleague) {
      throw new Error(store.config.colleagues.length === 0
        ? '当前没有可用的 Copilot：请确认本机档案已完善并已连上中继（列表由中继自动登记）。'
        : `找不到沟通方 “${input.to ?? '（未指定；有多个沟通方时必须显式指定 to）'}”。请先调用 talk2copilot_list_colleagues 查看可用列表（默认只含在线的同事，且不含你自己）。`);
    }
    // 停用优先于档案检查：这样报错说的是真正的原因（用户主动停用，而非等待同步）
    if (!colleagueEnabled(colleague)) {
      throw new Error(`沟通方 ${colleague.id} 已被停用，不能发送。如需与它通信，请在 Copilot2Copilot 配置界面启用它。`);
    }
    if (!store.hasPeerProfile(colleague)) {
      throw new Error(`尚未同步到同事 ${colleague.id} 的档案（角色/负责内容），暂不能通信。请确认对方已完善自己的档案并保持在线，且中继服务端已升级（未升级的中继不下发档案）。`);
    }

    // 熔断：窗口内与同一同事的往来条数达上限时拒绝继续发送，避免两端无人值守地互相追问
    if (store.isLoopSuspected(colleague.id)) {
      log(`[tool] send_message 被熔断阻止：${colleague.id} 窗口内往来已达 ${store.recentMessageCount(colleague.id)} 条`);
      throw new Error(`最近 ${LOOP_WINDOW_MS / 60000} 分钟内与 ${colleague.id} 的往来已达 ${LOOP_MESSAGE_LIMIT} 条，扩展已自动中止该会话以免两端无限对话。请把已获得的信息交给本机用户；若确需继续，可由用户在配置界面「维护」里重置熔断计数。`);
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

    // 默认等待对方回复（取配置的“等待回复默认超时”），显式传 0 才不等待
    const waitSec = Math.min(Math.max(input.wait_seconds ?? store.config.behavior.waitTimeoutSec, 0), 180);
    if (waitSec <= 0) {
      return json({
        status: reachable ? 'sent' : 'queued',
        request_id: env.id,
        target: colleague.id,
        hint: reachable
          ? '已按请求不等待回复；之后可用 talk2copilot_wait_reply 获取结果，或查看收件箱。'
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
          ? `已等待 ${waitSec} 秒仍未收到回复。请调用 talk2copilot_wait_reply（request_id="${env.id}"）继续等待，拿到对方回复后再继续。`
          : `对方当前离线（消息已排队），等待 ${waitSec} 秒未收到回复；对方上线后可用 talk2copilot_wait_reply 继续等待。`,
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
    if (!colleagueEnabled(store.findColleague(record.peerId))) {
      return json({
        status: 'blocked',
        request_id: input.request_id,
        hint: `沟通方 ${record.peerId} 已被停用，不会再有回复。请不要再等待；如需继续，可在配置界面启用该沟通方。`,
      });
    }
    // 熔断后对方不会再被自动唤醒，继续等待必然空转：直接给出终止信号
    if (store.isLoopSuspected(record.peerId)) {
      log(`[tool] wait_reply 终止：${record.peerId} 窗口内往来已达 ${store.recentMessageCount(record.peerId)} 条`);
      return json({
        status: 'blocked',
        request_id: input.request_id,
        hint: `与 ${record.peerId} 在 ${LOOP_WINDOW_MS / 60000} 分钟内的往来已达 ${LOOP_MESSAGE_LIMIT} 条，扩展已自动中止该会话，对方不会再回复。请不要再等待或重发，直接把已获得的信息交给本机用户；如需继续，可由用户在配置界面「维护」里重置熔断计数。`,
      });
    }
    if (record.done) {
      return json({ status: 'ok', request_id: input.request_id, reply: record.replyText });
    }
    const defaultSec = store.config.behavior.waitTimeoutSec;
    const waitSec = Math.min(Math.max(input.timeout_seconds ?? defaultSec, 1), 180);
    const reply = await waiters.waitFor(input.request_id, waitSec * 1000, token);
    if (!reply) {
      return json({
        status: 'pending',
        request_id: input.request_id,
        hint: `已等待 ${waitSec} 秒，仍未收到回复。请再次调用 talk2copilot_wait_reply 继续等待（每次最长 180 秒），直到拿到回复再继续。`,
      });
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
          `回复 ${record?.peerId ?? ''}（${options.input.request_id}，仅提供信息）：\n\n---\n\n${truncate(options.input.message)}` +
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
      throw new Error('通信通道未启动。请打开 Copilot2Copilot 配置界面检查中继地址与连接状态。');
    }
    const missingSelf = store.missingIdentityFields();
    if (missingSelf.length > 0) {
      throw new Error(`你的档案尚未完善（缺少：${missingSelf.join('、')}），暂不能通信。请打开 Copilot2Copilot 配置界面补全“我的档案”。`);
    }
    const original = store.findMessage(input.request_id);
    if (!original || original.direction !== 'in') {
      throw new Error(`找不到编号为 ${input.request_id} 的同事消息（或该消息不是你收到的）。请用 talk2copilot_list_inbox 核对。`);
    }
    const colleague = store.findColleague(original.peerId);
    if (!colleague) {
      throw new Error(`找不到沟通方 ${original.peerId}，无法回复。`);
    }
    if (!colleagueEnabled(colleague)) {
      throw new Error(`沟通方 ${colleague.id} 已被停用，不能回复。如需与它通信，请在 Copilot2Copilot 配置界面启用它。`);
    }
    if (!store.hasPeerProfile(colleague)) {
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

/** 解析要发送的文件路径：支持绝对路径与工作区内的相对路径 */
function resolveFilePath(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new Error('请提供要发送的文件路径（path）。');
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const hits = folders.map(f => path.join(f.uri.fsPath, raw)).filter(p => fs.existsSync(p));
  if (hits.length === 1) {
    return hits[0];
  }
  if (hits.length > 1) {
    throw new Error(`当前工作区有多个根目录，相对路径 ${raw} 有歧义，请改用绝对路径。`);
  }
  if (folders.length === 1) {
    // 不存在时也补成完整路径，让后续报错能指出实际查找位置
    return path.join(folders[0].uri.fsPath, raw);
  }
  throw new Error(`无法解析相对路径 ${raw}：当前未打开工作区，请改用绝对路径。`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} 字节`;
  }
  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1048576).toFixed(2)} MiB`;
}

interface SendFileInput {
  to?: string;
  path: string;
  message?: string;
}

export class SendFileTool implements vscode.LanguageModelTool<SendFileInput> {
  constructor(private readonly deps: ToolDeps) {}

  async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SendFileInput>): Promise<vscode.PreparedToolInvocation> {
    const colleague = this.deps.store.findColleague(options.input.to);
    const target = colleague ? `${colleague.id}（${colleague.role || '档案未同步'}）` : '未配置的沟通方';
    let desc: string;
    try {
      const abs = resolveFilePath(options.input.path);
      const stat = fs.statSync(abs);
      desc = `**${path.basename(abs)}**（${formatSize(stat.size)}）\n\n源路径：${abs}`;
    } catch (err) {
      desc = `无法读取待发送文件：${(err as Error).message}`;
    }
    return {
      invocationMessage: `正在向 ${colleague?.id ?? '沟通方'} 发送文件`,
      confirmationMessages: {
        title: '向同事发送文件',
        message: new vscode.MarkdownString(
          `把以下文件发送给 **${target}**（对方只能读取，是否落地由对方用户决定）：\n\n---\n\n${desc}` +
          (options.input.message ? `\n\n附言：${truncate(options.input.message)}` : ''),
        ),
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<SendFileInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const { store, fileHub } = this.deps;
    const input = options.input;
    if (!this.deps.getTransport()) {
      throw new Error('通信通道未启动。请打开 Copilot2Copilot 配置界面检查中继地址与连接状态。');
    }
    const missingSelf = store.missingIdentityFields();
    if (missingSelf.length > 0) {
      throw new Error(`你的档案尚未完善（缺少：${missingSelf.join('、')}），暂不能通信。请打开 Copilot2Copilot 配置界面补全“我的档案”。`);
    }
    if (input.to && input.to === store.config.identity.id) {
      throw new Error('不能给自己发送文件：to 要填对方的 id（你自己的 id 不会出现在 Copilot 列表里）。');
    }
    const colleague = store.findColleague(input.to);
    if (!colleague) {
      throw new Error(store.config.colleagues.length === 0
        ? '当前没有可用的 Copilot：请确认本机档案已完善并已连上中继（列表由中继自动登记）。'
        : `找不到沟通方 “${input.to ?? '（未指定；有多个沟通方时必须显式指定 to）'}”。请先调用 talk2copilot_list_colleagues 查看可用列表（默认只含在线的同事，且不含你自己）。`);
    }
    if (!colleagueEnabled(colleague)) {
      throw new Error(`沟通方 ${colleague.id} 已被停用，不能发送。如需与它通信，请在 Copilot2Copilot 配置界面启用它。`);
    }
    if (!store.hasPeerProfile(colleague)) {
      throw new Error(`尚未同步到同事 ${colleague.id} 的档案（角色/负责内容），暂不能通信。请确认对方已完善自己的档案并保持连接。`);
    }
    if (store.isLoopSuspected(colleague.id)) {
      log(`[tool] send_file 被熔断阻止：${colleague.id} 窗口内往来已达 ${store.recentMessageCount(colleague.id)} 条`);
      throw new Error(`最近 ${LOOP_WINDOW_MS / 60000} 分钟内与 ${colleague.id} 的往来已达 ${LOOP_MESSAGE_LIMIT} 条，扩展已自动中止该会话以免两端无限对话。请把已获得的信息交给本机用户；若确需继续，可由用户在配置界面「维护」里重置熔断计数。`);
    }
    const filePath = resolveFilePath(input.path);
    log(`[tool] send_file → ${colleague.id}（${filePath}）`);
    const result = await fileHub.sendFile(colleague.id, filePath, input.message ?? '', token);
    await store.appendMessage({
      id: result.transferId,
      direction: 'out',
      peerId: colleague.id,
      text: input.message ?? '',
      ts: Date.now(),
      done: false,
      file: { name: result.meta.name, size: result.meta.size, sha256: result.meta.sha256, path: filePath },
    });
    return json({
      status: 'ok',
      request_id: result.transferId,
      target: colleague.id,
      file: { name: result.meta.name, size: result.meta.size, sha256: result.meta.sha256 },
      saved_name: result.savedName,
      hint: '文件已送达对方收件箱（sha256 已校验），对方 Copilot 会收到带本机路径的通知。若你在附言里提了问题，可用 talk2copilot_wait_reply 继续等待回复；对方是否把文件应用到其工作区由对方用户决定。',
    });
  }
}

interface ListColleaguesInput {
  include_offline?: boolean;
}

export class ListColleaguesTool implements vscode.LanguageModelTool<ListColleaguesInput> {
  constructor(private readonly deps: ToolDeps) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ListColleaguesInput>): Promise<vscode.LanguageModelToolResult> {
    const { store, getTransport } = this.deps;
    const transport = getTransport();
    const includeOffline = options.input?.include_offline === true;
    const mine = store.config.identity.id;
    // 指向本窗口自己的条目（id 或中继 id 命中自己）一律不出现在模型可见列表里
    const configured = store.config.colleagues.filter(c => c.id !== mine && c.relayPeerId !== mine);
    const enabledList = configured.filter(colleagueEnabled);
    const colleagues = enabledList
      .filter(c => includeOffline || (transport?.isOnline(c.id) ?? false))
      .map(c => ({
        id: c.id,
        role: c.role,
        scope: c.scope,
        online: transport?.isOnline(c.id) ?? false,
        profile_ready: store.hasPeerProfile(c),
      }));
    const note = colleagues.length > 0
      ? undefined
      : configured.length === 0
        ? '当前没有可用沟通方：连上中继后，在线设备会被自动登记到列表中。'
        : enabledList.length === 0
          ? '当前所有沟通方都已被停用，如需使用请在 Copilot2Copilot 配置界面启用。'
          : '当前没有在线的 Copilot（离线条目默认不列出；如需查看全部已配置条目，可传 include_offline=true）。';
    return json({
      mode: '中继',
      my_id: store.config.identity.id,
      colleagues,
      ...(note ? { note } : {}),
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
        file: i.file
          ? { name: i.file.name, size: i.file.size, sha256: i.file.sha256, saved_path: i.file.path }
          : undefined,
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
    vscode.lm.registerTool('talk2copilot_send_file', new SendFileTool(deps)),
  );
}

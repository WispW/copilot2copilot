import * as vscode from 'vscode';
import * as fs from 'fs';
import { log, showLogs } from './logger';
import { AdminMemoryFilters, AdminMemoryRoomStats, PanelState } from './panelTypes';
import { ColleagueProfile, MemoryEntry, RoomCategory, RoomSummary } from './protocol';
import { AppConfig, ColleagueConfig, LOOP_MESSAGE_LIMIT, LOOP_WINDOW_MS, Store } from './store';
import { ControlResult, TransportStatus } from './transport/types';

interface PanelDeps {
  getStatus(): TransportStatus;
  getOnlineIds(): string[];
  /** 重新连接：保存并应用，以及界面上的「连接 / 重试连接」都走这里 */
  restart(): Promise<void>;
  /** 手动断开：停止通道，之后不再自动重连 */
  disconnect(): Promise<void>;
  control(kind: 'room' | 'admin' | 'memory', op: string, payload?: Record<string, unknown>): Promise<ControlResult>;
  refreshAdmin(): Promise<void>;
}

/** CSV 单元格转义：含引号/逗号/换行的内容整体加引号并转义内部引号 */
function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 记忆条目 → CSV（含状态与时间，便于数据库式查看） */
function memoryCsv(entries: MemoryEntry[]): string {
  const header = [
    'id', 'roomId', 'roomName', 'state', 'text', 'tags', 'author', 'createdAt',
    'revision', 'updatedBy', 'updatedAt', 'sourceRequestId', 'deletedBy', 'deletedAt',
  ];
  const lines = [header.join(',')];
  for (const entry of entries) {
    lines.push([
      entry.id,
      entry.roomId,
      entry.roomName,
      entry.deleted ? 'deleted' : 'active',
      entry.text,
      entry.tags.join(' '),
      entry.author,
      new Date(entry.createdAt).toISOString(),
      entry.revision,
      entry.updatedBy,
      new Date(entry.updatedAt).toISOString(),
      entry.sourceRequestId ?? '',
      entry.deleted?.by ?? '',
      entry.deleted ? new Date(entry.deleted.at).toISOString() : '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

export class ConsolePanel {
  private panel?: vscode.WebviewPanel;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly deps: PanelDeps,
  ) {
    this.store.onDidChange(() => this.postState());
    context.subscriptions.push(this.registerSerializer());
  }

  /** 接管被 VS Code 恢复的页面，避免重载后再次点击又开一个 */
  private registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer('talk2copilot.console', {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
        log('[panel] 接管已恢复的配置页面');
        this.attach(panel);
        this.postState();
      },
    });
  }

  /** 打开配置页面：已存在则只聚焦，保证全局单例 */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      this.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel('talk2copilot.console', 'Copilot2Copilot', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // 只放开实际被加载的两个目录：脚本在 dist/（构建产物）、样式在 media/
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    });
    log('[panel] 打开配置页面');
    this.attach(panel);
    this.postState();
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview, this.context.extensionUri);
    panel.webview.onDidReceiveMessage(msg => void this.handleMessage(msg), undefined, this.context.subscriptions);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
      this.stopRefresh();
    }, undefined, this.context.subscriptions);
    this.startRefresh();
  }

  /** 页面存在期间低频推送，保证界面始终最新（热刷新兜底） */
  private startRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setInterval(() => this.postState(), 5000);
  }

  private stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  postState(resetDraft = false): void {
    void this.panel?.webview.postMessage({ type: 'state', resetDraft, state: this.buildState() });
  }

  private buildState(): PanelState {
    return {
      config: { ...this.store.config, identity: this.store.templateIdentity },
      effectiveIdentity: this.store.identity,
      workspaceIdentity: this.store.workspaceIdentity,
      workspaceLabel: this.store.workspaceLabel(),
      status: this.deps.getStatus(),
      messages: this.store.listMessages(50),
      onlineIds: this.deps.getOnlineIds(),
      identityMissing: this.store.missingIdentityFields(),
      rooms: this.store.getRooms(),
      categories: this.store.getCategories(),
      admin: { tokenSet: this.store.hasAdminToken(), ...this.store.getAdminState() },
      relayInfo: this.store.getRelayInfo(),
      extensionVersion: this.store.extensionVersion,
      loopGuard: { windowMs: LOOP_WINDOW_MS, limit: LOOP_MESSAGE_LIMIT },
    };
  }

  /** 拉取记忆列表并推送给界面（打开面板 / 增删改后刷新都走这里） */
  private async pushMemoryList(roomId: string, cursor?: string, includeDeleted = false): Promise<void> {
    const result = await this.deps.control('memory', 'list', {
      roomId,
      limit: 50,
      ...(cursor ? { cursor } : {}),
      ...(includeDeleted ? { includeDeleted: true } : {}),
    });
    this.sendMemoryState(roomId, 'list', result);
  }

  /** 记忆检索：roomId 为空时检索我加入的全部房间 */
  private async pushMemorySearch(roomId: string, query: string): Promise<void> {
    const result = await this.deps.control('memory', 'query', {
      query,
      topK: 50,
      ...(roomId ? { roomId } : {}),
    });
    this.sendMemoryState(roomId, 'search', result, query);
  }

  private sendMemoryState(roomId: string, mode: 'list' | 'search', result: ControlResult, query?: string): void {
    const payload = (result.env?.payload ?? {}) as {
      entries?: MemoryEntry[];
      results?: MemoryEntry[];
      total?: number;
      nextCursor?: string;
    };
    const entries = mode === 'search' ? (payload.results ?? []) : (payload.entries ?? []);
    void this.panel?.webview.postMessage({
      type: 'memoryState',
      roomId,
      mode,
      ...(query !== undefined ? { query } : {}),
      entries,
      total: mode === 'search' ? entries.length : (payload.total ?? entries.length),
      nextCursor: mode === 'search' ? '' : (payload.nextCursor ?? ''),
      ...(result.ok ? {} : { error: result.error ?? '记忆查询失败' }),
    });
  }

  /** 管理员记忆列表（数据库视图）：按筛选条件分页拉取并推送 */
  private async pushAdminMemory(filters: AdminMemoryFilters): Promise<void> {
    const result = await this.deps.control('admin', 'memory-list', {
      limit: 50,
      includeDeleted: filters.includeDeleted !== false,
      ...(filters.deletedOnly ? { deletedOnly: true } : {}),
      ...(filters.roomId ? { roomId: filters.roomId } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.author ? { author: filters.author } : {}),
      ...(filters.tag ? { tag: filters.tag } : {}),
      ...(filters.cursor ? { cursor: filters.cursor } : {}),
    });
    const payload = (result.env?.payload ?? {}) as {
      entries?: MemoryEntry[];
      total?: number;
      nextCursor?: string;
      rooms?: AdminMemoryRoomStats[];
    };
    void this.panel?.webview.postMessage({
      type: 'adminMemoryState',
      entries: payload.entries ?? [],
      total: payload.total ?? 0,
      nextCursor: payload.nextCursor ?? '',
      rooms: payload.rooms ?? [],
      filters,
      ...(result.ok ? {} : { error: result.error ?? '记忆列表获取失败' }),
    });
  }

  /** 管理员记忆详情（含历史版本）；取不到时让界面关闭详情 */
  private async pushAdminMemoryDetail(entryId: string): Promise<void> {
    const result = await this.deps.control('memory', 'get', { entryId });
    const entry = result.ok
      ? (result.env?.payload as { entry?: MemoryEntry } | undefined)?.entry
      : undefined;
    void this.panel?.webview.postMessage({
      type: 'adminMemoryDetail',
      ...(entry ? { entry } : {}),
      ...(result.ok ? {} : { error: result.error ?? '记忆详情获取失败' }),
    });
  }

  /** 记忆导出（JSON / CSV）：按当前筛选分页取全量，再写用户选择的文件 */
  private async exportAdminMemory(format: 'json' | 'csv', filters: AdminMemoryFilters): Promise<void> {
    const entries: MemoryEntry[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page += 1) {
      const result = await this.deps.control('admin', 'memory-list', {
        limit: 100,
        includeDeleted: filters.includeDeleted !== false,
        ...(filters.deletedOnly ? { deletedOnly: true } : {}),
        ...(filters.roomId ? { roomId: filters.roomId } : {}),
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.author ? { author: filters.author } : {}),
        ...(filters.tag ? { tag: filters.tag } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) {
        void vscode.window.showWarningMessage(`Copilot2Copilot：导出失败——${result.error ?? '读取记忆列表失败'}`);
        return;
      }
      const payload = (result.env?.payload ?? {}) as { entries?: MemoryEntry[]; nextCursor?: string };
      entries.push(...(payload.entries ?? []));
      cursor = payload.nextCursor ?? '';
      if (!cursor) {
        break;
      }
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const uri = await vscode.window.showSaveDialog({
      saveLabel: '导出',
      defaultUri: vscode.Uri.file(`copilot2copilot-memory-${stamp}.${format}`),
      filters: format === 'json' ? { JSON: ['json'] } : { CSV: ['csv'] },
    });
    if (!uri) {
      return;
    }
    const content = format === 'json'
      ? `${JSON.stringify({ exportedAt: new Date().toISOString(), count: entries.length, entries }, null, 2)}\n`
      : `${memoryCsv(entries)}\n`;
    try {
      fs.writeFileSync(uri.fsPath, content, 'utf8');
    } catch (err) {
      void vscode.window.showWarningMessage(`Copilot2Copilot：写入导出文件失败——${(err as Error).message}`);
      return;
    }
    log(`[panel] 已导出 ${entries.length} 条记忆到 ${uri.fsPath}`);
    void vscode.window.showInformationMessage(`Copilot2Copilot：已导出 ${entries.length} 条记忆到 ${uri.fsPath}`);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    const m = msg as {
      type?: string;
      config?: AppConfig;
      token?: string;
      adminToken?: string;
      peerId?: string;
      enabled?: boolean;
      identity?: ColleagueProfile;
      op?: string;
      payload?: Record<string, unknown>;
      roomId?: string;
      cursor?: string;
      includeDeleted?: boolean;
      query?: string;
      text?: string;
      tags?: string[];
      entryId?: string;
      revision?: number;
      filters?: AdminMemoryFilters;
      format?: string;
    };
    switch (m.type) {
      case 'ready':
        this.postState();
        break;
      case 'connect':
        log('[panel] 界面请求连接中继');
        await this.deps.restart();
        this.postState();
        break;
      case 'disconnect':
        log('[panel] 界面请求断开中继');
        await this.deps.disconnect();
        this.postState();
        break;
      case 'save': {
        log(`[panel] 保存配置：同事数=${m.config?.colleagues?.length ?? '?'}`);
        if (m.config) {
          // 以 store 现有列表为基：快照里没有的条目（保存瞬间刚被中继发现的同事）必须保留，
          // 否则这次保存会把它从配置里删掉；role/scope 一律以 store 的同步值为准，
          // 避免界面旧快照把它们覆盖成空
          const byId = new Map((m.config.colleagues as ColleagueConfig[]).map(raw => [raw.id, raw]));
          const merged: AppConfig = {
            ...m.config,
            colleagues: this.store.config.colleagues.map(current => {
              const raw = byId.get(current.id);
              if (!raw) {
                return current;
              }
              return {
                id: current.id,
                role: current.role,
                scope: current.scope,
                relayPeerId: raw.relayPeerId ?? current.relayPeerId,
                enabled: raw.enabled !== false,
              };
            }),
          };
          await this.store.updateConfig(merged);
        }
        await this.store.setWorkspaceIdentity(m.identity ?? {});
        if (typeof m.token === 'string' && m.token.trim().length > 0) {
          await this.store.setToken(m.token.trim());
        }
        if (typeof m.adminToken === 'string' && m.adminToken.trim().length > 0) {
          await this.store.setAdminToken(m.adminToken.trim());
          log('[panel] 已保存中继管理令牌');
        }
        await this.deps.restart();
        this.postState(true);
        void vscode.window.showInformationMessage(
          `Copilot2Copilot：已保存本工作区档案（id=${this.store.identity.id || '未填'}）并应用`,
        );
        break;
      }
      case 'roomOp': {
        const op = String(m.op ?? '');
        log(`[panel] 房间操作 ${op}`);
        // 房间列表对所有人可见，因此加入 / 退出前就能查到房间名用于提示
        const roomId = String((m.payload as { roomId?: string } | undefined)?.roomId ?? '');
        const roomName = this.store.getRooms().find(room => room.id === roomId)?.name ?? '';
        const result = await this.deps.control('room', op, m.payload);
        const data = result.env?.payload as { rooms?: RoomSummary[]; categories?: RoomCategory[] } | undefined;
        if (result.ok && Array.isArray(data?.rooms)) {
          this.store.setRooms(data.rooms);
        }
        if (result.ok && Array.isArray(data?.categories)) {
          this.store.setCategories(data.categories);
        }
        if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '房间操作失败'}`);
        } else if (op === 'join') {
          void vscode.window.showInformationMessage(`Copilot2Copilot：已加入房间${roomName ? `「${roomName}」` : ''}，同房间成员会出现在列表中`);
        } else if (op === 'leave') {
          void vscode.window.showInformationMessage(`Copilot2Copilot：已退出房间${roomName ? `「${roomName}」` : ''}`);
        }
        // 房间成员变化会影响管理页的设备行与房间移出名单：一并刷新
        if (result.ok && this.store.hasAdminToken()) {
          await this.deps.refreshAdmin();
        }
        this.postState();
        break;
      }
      case 'refreshRooms': {
        const result = await this.deps.control('room', 'list');
        const data = result.env?.payload as { rooms?: RoomSummary[] } | undefined;
        if (result.ok && Array.isArray(data?.rooms)) {
          this.store.setRooms(data.rooms);
        } else if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '刷新房间列表失败'}`);
        }
        this.postState();
        break;
      }
      case 'adminOp': {
        const op = String(m.op ?? '');
        log(`[panel] 管理操作 ${op}`);
        const payload = (m.payload ?? {}) as { target?: string; name?: string; memberId?: string; roomId?: string; categoryId?: string };
        // 操作完成后房间 / 分类列表会由中继的 room-event 刷新；这里先按当前快照给出提示里的名字
        const roomName = payload.roomId ? this.store.getRooms().find(room => room.id === payload.roomId)?.name ?? '' : '';
        const categoryName = payload.categoryId
          ? this.store.getCategories().find(category => category.id === payload.categoryId)?.name ?? ''
          : '';
        const result = await this.deps.control('admin', op, m.payload);
        if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '管理操作失败'}`);
        } else {
          log(`[panel] 管理操作 ${op} 已生效`);
          const target = String(payload.target ?? '');
          if (op === 'ban') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已封禁 ${target}（它已断开且无法接入），可在「管理 → 封禁名单」解除`);
          } else if (op === 'unban') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已解除 ${target} 的封禁，对方可点「重试连接」重新接入（不会自动重连）`);
          } else if (op === 'kick') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已把 ${target} 移出中继，对方需手动点「重试连接」才能恢复（不会自动重连）`);
          } else if (op === 'room-create') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已创建房间「${payload.name ?? ''}」——房间列表所有设备可见，把密码告诉同事即可加入`);
          } else if (op === 'room-kick') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已把 ${payload.memberId ?? ''} 移出房间${roomName ? `「${roomName}」` : ''}（进入该房间的禁止名单，可在房间管理里解除）`);
          } else if (op === 'room-unblock') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已解除 ${payload.memberId ?? ''} 的房间移出限制，对方可凭密码重新加入`);
          } else if (op === 'room-dissolve') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已解散房间${roomName ? `「${roomName}」` : ''}`);
          } else if (op === 'category-create') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已创建分类「${payload.name ?? ''}」`);
          } else if (op === 'category-rename') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已把分类${categoryName ? `「${categoryName}」` : ''}改名`);
          } else if (op === 'category-delete') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已删除分类${categoryName ? `「${categoryName}」` : ''}，其下房间已回到「未分类」（房间本身没有删除）`);
          }
        }
        await this.deps.refreshAdmin();
        this.postState();
        break;
      }
      case 'refreshAdmin': {
        await this.deps.refreshAdmin();
        this.postState();
        break;
      }
      case 'clearHistory':
        await this.store.clearMessages();
        break;
      case 'openFilesDir': {
        const dir = this.store.filesDir();
        log(`[panel] 打开文件收件目录 ${dir}`);
        try {
          // openExternal 被系统拒绝时返回 false（不抛异常），两种失败都要给出路径提示
          if (!(await vscode.env.openExternal(vscode.Uri.file(dir)))) {
            throw new Error('系统未接受打开请求');
          }
        } catch {
          void vscode.window.showWarningMessage(`Copilot2Copilot：无法自动打开收件目录，路径为 ${dir}`);
        }
        break;
      }
      case 'resetLoopGuard': {
        this.store.resetLoopGuard();
        log('[panel] 已重置熔断计数');
        void vscode.window.showInformationMessage('Copilot2Copilot：熔断计数已重置，可以与同事继续通信。');
        this.postState();
        break;
      }
      case 'toggleColleague': {
        if (typeof m.peerId === 'string' && m.peerId) {
          await this.store.setColleagueEnabled(m.peerId, m.enabled === true);
          log(`[panel] ${m.enabled === true ? '启用' : '停用'}沟通方 ${m.peerId}`);
          this.postState();
        }
        break;
      }
      case 'saveTemplate': {
        await this.store.saveTemplateFromCurrent();
        log('[panel] 已把当前档案的角色/负责内容存为模板');
        void vscode.window.showInformationMessage('Copilot2Copilot：已把当前角色与负责内容存为模板，供新工作区预填（不含 id）。');
        this.postState();
        break;
      }
      case 'memoryList': {
        const roomId = String(m.roomId ?? '');
        if (roomId) {
          await this.pushMemoryList(roomId, m.cursor, m.includeDeleted === true);
        }
        break;
      }
      case 'memorySearch': {
        const query = String(m.query ?? '').trim();
        if (query) {
          await this.pushMemorySearch(String(m.roomId ?? ''), query);
        }
        break;
      }
      case 'memoryCreate': {
        const roomId = String(m.roomId ?? '');
        const text = String(m.text ?? '').trim();
        if (roomId && text) {
          log(`[panel] 写入共享记忆（房间 ${roomId}，${text.length} 字符）`);
          const result = await this.deps.control('memory', 'remember', {
            roomId,
            text,
            tags: Array.isArray(m.tags) ? m.tags : [],
          });
          if (!result.ok) {
            void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '写入记忆失败'}`);
          }
          await this.pushMemoryList(roomId);
        }
        break;
      }
      case 'memoryUpdate': {
        const roomId = String(m.roomId ?? '');
        const entryId = String(m.entryId ?? '');
        if (entryId) {
          log(`[panel] 更新共享记忆 ${entryId}`);
          const result = await this.deps.control('memory', 'update', {
            entryId,
            revision: Number(m.revision),
            text: String(m.text ?? ''),
            tags: Array.isArray(m.tags) ? m.tags : [],
          });
          if (!result.ok) {
            void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '更新记忆失败'}`);
          }
          await this.pushMemoryList(roomId);
        }
        break;
      }
      case 'memoryDelete': {
        const roomId = String(m.roomId ?? '');
        const entryId = String(m.entryId ?? '');
        if (entryId) {
          log(`[panel] 删除共享记忆 ${entryId}`);
          const result = await this.deps.control('memory', 'delete', {
            entryId,
            revision: Number(m.revision),
          });
          if (!result.ok) {
            void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '删除记忆失败'}`);
          }
          await this.pushMemoryList(roomId);
        }
        break;
      }
      case 'memoryRestore': {
        const roomId = String(m.roomId ?? '');
        const entryId = String(m.entryId ?? '');
        if (entryId) {
          log(`[panel] 恢复共享记忆 ${entryId}`);
          const result = await this.deps.control('memory', 'restore', { entryId });
          if (!result.ok) {
            void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '恢复记忆失败'}`);
          }
          await this.pushMemoryList(roomId);
        }
        break;
      }
      case 'adminMemoryList': {
        await this.pushAdminMemory(m.filters ?? { includeDeleted: true });
        break;
      }
      case 'adminMemoryGet': {
        const entryId = String(m.entryId ?? '');
        if (entryId) {
          await this.pushAdminMemoryDetail(entryId);
        }
        break;
      }
      case 'adminMemoryUpdate': {
        const entryId = String(m.entryId ?? '');
        const filters = m.filters ?? { includeDeleted: true };
        if (entryId) {
          log(`[panel] 管理员更新记忆 ${entryId}`);
          const result = await this.deps.control('admin', 'memory-update', {
            entryId,
            text: String(m.text ?? ''),
            tags: Array.isArray(m.tags) ? m.tags : [],
          });
          if (!result.ok) {
            void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '更新记忆失败'}`);
          }
          await this.pushAdminMemory(filters);
          await this.pushAdminMemoryDetail(entryId);
        }
        break;
      }
      case 'adminMemoryRestore': {
        const entryId = String(m.entryId ?? '');
        const filters = m.filters ?? { includeDeleted: true };
        if (entryId) {
          log(`[panel] 管理员恢复 / 回滚记忆 ${entryId}${m.revision !== undefined ? ` → r${m.revision}` : ''}`);
          const result = await this.deps.control('admin', 'memory-restore', {
            entryId,
            ...(m.revision !== undefined ? { revision: Number(m.revision) } : {}),
          });
          if (!result.ok) {
            void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '恢复记忆失败'}`);
          }
          await this.pushAdminMemory(filters);
          await this.pushAdminMemoryDetail(entryId);
        }
        break;
      }
      case 'adminMemoryPurge': {
        const filters = m.filters ?? { includeDeleted: true };
        const entryId = String(m.entryId ?? '');
        const roomId = String(m.roomId ?? '');
        if (!entryId && !roomId) {
          break;
        }
        log(`[panel] 管理员彻底删除记忆 ${entryId || `（清空房间 ${roomId}）`}`);
        const result = await this.deps.control(
          'admin',
          'memory-purge',
          entryId ? { entryId } : { roomId, confirm: true },
        );
        if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '删除记忆失败'}`);
        } else if (entryId) {
          void vscode.window.showInformationMessage('Copilot2Copilot：已彻底删除该条记忆（不可恢复）。');
        } else {
          const removed = (result.env?.payload as { removed?: number } | undefined)?.removed ?? 0;
          void vscode.window.showInformationMessage(`Copilot2Copilot：已清空该房间的记忆（共 ${removed} 条，不可恢复）。`);
        }
        await this.pushAdminMemory(filters);
        void this.panel?.webview.postMessage({ type: 'adminMemoryDetail' }); // 关闭详情
        break;
      }
      case 'adminMemoryExport': {
        await this.exportAdminMemory(m.format === 'csv' ? 'csv' : 'json', m.filters ?? { includeDeleted: true });
        break;
      }
      case 'uiError':
        log(`[panel] 界面脚本错误：${(m as { message?: string }).message ?? '(未知)'}`);
        break;
      case 'uiHint':
        // 界面侧的输入校验提示（如房间名为空）：转成 VS Code 弹窗，避免"点了没反应"
        log(`[panel] 界面提示：${(m as { message?: string }).message ?? ''}`);
        void vscode.window.showWarningMessage(`Copilot2Copilot：${(m as { message?: string }).message ?? ''}`);
        break;
      case 'showLogs':
        showLogs();
        break;
      default:
        break;
    }
  }

  private renderHtml(webview: vscode.Webview, root: vscode.Uri): string {
    // 界面脚本是构建产物（src/webview/ → dist/webview.js），样式仍是手写文件
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'main.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Copilot2Copilot</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

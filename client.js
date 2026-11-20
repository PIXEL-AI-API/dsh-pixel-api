// PIXEL API — browser half. Registers the 设置 → PIXEL API page and the
// two-column model picker. The page reads the host's auth status together
// with the PIXEL credential references (password set = a sign-in in flight,
// 2FA code set = a code being checked, refresh set = the session itself) and
// shows either the login card (username + password, then a one-shot TOTP
// step) or the account view: identity, balance, context window, GPT replay,
// plugin version, sign-out. No secret is held here beyond the field being
// typed into — the host half owns tokens, refresh, and chat traffic.

window.__ModuleLoader__.load({
  id: 'dsh-pixel-api',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useId, useRef, useState } = React
    // react-dom comes from the same browser module table as react; if a
    // build ever omits it, render the panel inline (still position:fixed).
    let createPortal = (node) => node
    try {
      const dom = require('react-dom')
      if (dom && typeof dom.createPortal === 'function') createPortal = dom.createPortal
    } catch {
      // keep the inline fallback
    }

    const PLUGIN_ID = 'dsh-pixel-api'
    const NS = 'pixel-api'
    const SITE_URL = 'https://api.ai-pixel.online'
    const SITE_HOST = SITE_URL.replace(/^https:\/\//, '')
    const STYLE_ID = PLUGIN_ID + '/pixel-api.css'
    const REFS = {
      password: 'PIXEL_API_PASSWORD',
      refresh: 'PIXEL_API_REFRESH',
      otp: 'PIXEL_API_2FA',
    }
    // A sign-in still running after this long gets a "still waiting" line.
    const SLOW_SIGN_IN_MS = 12000
    // Refresh / retry spinners stop on the next auth status or after this.
    const REFRESH_SPIN_MS = 15000
    // A request the host serves once (检查更新, 更新, 2FA 返回) is re-read this
    // often while it waits, and given up after HOST_WAIT_MS.
    const HOST_POLL_MS = 2000
    const HOST_WAIT_MS = 30000
    // 「已保存」: 240 ms in, 2 s shown, 240 ms out.
    const SAVED_NOTICE_MS = 2240
    // The field-error shake, and the status dot's pulse after a sign-in.
    const SHAKE_MS = 320
    const PULSE_MS = 900
    const PULSE_DELAY_MS = 240
    const OTP_LENGTH = 6

    const zh = {
      'login.title': '登录 PIXEL 主站',
      'login.subtitle': '{site} · 对话按主站钱包余额计费，无需 API Key',
      'field.username': '用户名',
      'field.password': '密码',
      'field.otp': '两步验证码',
      'action.showPassword': '显示密码',
      'action.hidePassword': '隐藏密码',
      'action.login': '登录',
      'action.loggingIn': '登录中…',
      'login.slow': '仍在等待主站响应…',
      'err.username': '请输入用户名',
      'err.password': '请输入密码',
      'err.otpFailed': '两步验证未通过：{reason}，请重新登录',
      'hint.session': '密码只用于这次登录，用完即从本机删除；本机只保留主站签发的登录会话（约 30 天，自动续期）。',
      'otp.title': '两步验证',
      'otp.subtitle': '{user} 已启用两步验证，请输入验证器中的 6 位验证码',
      'action.verify': '验证并登录',
      'action.verifying': '验证中…',
      'action.back': '返回',
      'status.loading': '正在加载',
      'status.ok': '已连接',
      'status.interrupted': '连接中断',
      'load.failed': '读取设置失败：{reason}',
      'action.retry': '重试',
      'action.retryNow': '立即重试',
      'action.openSite': '打开主站',
      'ok.balance': '余额',
      'ok.used': '已用 {used}',
      'ok.requests': '{count} 次请求',
      'ok.updated': '{time} 更新',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中',
      'action.topup': '充值',
      'ok.mounted': '已挂载 {groups} 个分组 · {models} 个模型',
      'ok.mountedNoModels': '已挂载 {groups} 个分组',
      'action.logout': '退出登录',
      'logout.confirm': '确定退出？',
      'action.cancel': '取消',
      'ctx.title': '上下文窗口',
      'ctx.summary': '默认 {window} token · {rules} 条单独设置',
      'ctx.edit': '编辑',
      'ctx.collapse': '收起',
      'ctx.desc': 'Harness 按这个窗口决定何时压缩历史、会话中途能否切换到 PIXEL 模型。主站不提供各模型的实际上限，与实际不符时在这里调整。',
      'ctx.default': '默认窗口（token）',
      'ctx.overrides': '按模型单独设置',
      'ctx.overrides.placeholder': '每行一条：模型 ID = token 数，以 * 结尾按前缀匹配\ngemini-* = 1048576\nclaude-opus-5-5 = 1000000',
      'ctx.hint': '精确的模型 ID 优先于前缀，较长的前缀优先于较短的，不区分大小写；数字可写 272k、1m。修改从下一次请求起生效。',
      'ctx.save': '保存',
      'ctx.saving': '保存中…',
      'ctx.reset': '恢复默认',
      'ctx.saved': '已保存',
      'err.ctx.default': '默认窗口必须是大于 65536 的整数（Harness 压缩默认预留 65536 token）。',
      'err.ctx.line': '第 {line} 行格式不对：应为「模型 ID = token 数」，token 数须为大于 65536 的整数。',
      'err.ctx.star': '第 {line} 行：单独的 * 会覆盖所有模型，请直接修改默认窗口。',
      'replay.title': 'GPT 加密推理回传',
      'replay.summary': '多渠道分组可能失败，默认关闭',
      'replay.desc': '开启后，GPT 模型在工具调用的每一步会带回上一步的加密推理，推理更连贯。主站只认产生它的上游账号：同一分组有多个渠道、而主站没有对 /pg/chat/completions 开渠道亲和时，请求换到别的账号会失败，这个会话后面的请求也会跟着失败，关掉本开关即可恢复。确认分组只有一个渠道或主站已配置亲和后再开。',
      'upd.title': '插件版本',
      'upd.idle': '平时不联网，点「检查更新」从 GitHub 读取最新版本',
      'upd.checking': '正在检查…',
      'upd.latest': '已是最新',
      'upd.checkedAt': '{time} 检查',
      'upd.available': '可更新到 v{version}',
      'upd.availableHint': '更新时插件管理会先移除当前版本再安装新版本，期间 PIXEL 模型和本页会暂时消失；安装失败会自动恢复当前版本。',
      'upd.unsupported': '最新 v{version}，这份插件不能在这里一键更新：{reason}',
      'upd.error': '检查更新失败：{reason}',
      'upd.updating': '正在更新到 v{version}，完成后本页会自动恢复；如果一直没有恢复，请重启 DeepSeek Harness',
      'upd.updated': '已更新到 v{version}',
      'upd.restart': 'v{version} 已安装，重启 DeepSeek Harness 后生效',
      'upd.failed': '更新失败：{reason}',
      'upd.check': '检查更新',
      'upd.apply': '更新到 v{version}',
      'upd.applying': '更新中…',
      'upd.confirm': '确认更新',
      'picker.account': 'DeepSeek 账号',
      'picker.loading': '正在加载模型…',
      'picker.choose': '请选择模型',
      'picker.title': '选择模型',
      'picker.search': '搜索模型…（↑↓ 选择，Alt+←→ 切换分组，Enter 确认）',
      'picker.groups': '模型分组',
      'picker.models': '模型',
      'picker.refreshing': '正在刷新模型列表…',
      'picker.noMatch': '没有匹配的分组',
      'picker.empty': '暂无可用模型',
      'picker.groupEmpty': '该分组暂无模型',
      'picker.currentGroup': '当前模型所在分组',
      'picker.groupId': 'ID: {id}',
      'picker.tip.id': 'ID：{id}',
      'picker.tip.ratio': '倍率：×{ratio}',
      'picker.head.id': 'ID {id}',
      'picker.head.ratio': '倍率 ×{ratio}',
      'picker.ratio.auto': '自动',
      'picker.switching': '切换中…',
      'picker.effort': '推理等级',
      'picker.defaultEffort': 'Default',
      'picker.catalogFailed': '模型目录加载失败：{reason}',
      'picker.groupFailed': '{group} 加载失败：{reason}',
      'picker.writerHeld': '当前会话已被其他 DSH 实例占用，请退出其他实例后重试',
      'picker.switchFailed': '切换失败：{reason}',
      'picker.unknownError': '未知错误',
    }

    const en = {
      'login.title': 'Sign in to PIXEL',
      'login.subtitle': '{site} · Chats bill your site wallet; no API key needed',
      'field.username': 'Username',
      'field.password': 'Password',
      'field.otp': 'Two-step code',
      'action.showPassword': 'Show password',
      'action.hidePassword': 'Hide password',
      'action.login': 'Sign in',
      'action.loggingIn': 'Signing in…',
      'login.slow': 'Still waiting for the site…',
      'err.username': 'Enter your username',
      'err.password': 'Enter your password',
      'err.otpFailed': 'Two-step verification failed: {reason}. Sign in again.',
      'hint.session': 'The password is used for this sign-in only and deleted from this machine right after; only the site-issued session is kept (about 30 days, renewed automatically).',
      'otp.title': 'Two-step verification',
      'otp.subtitle': '{user} uses two-step verification. Enter the 6-digit code from your authenticator.',
      'action.verify': 'Verify and sign in',
      'action.verifying': 'Verifying…',
      'action.back': 'Back',
      'status.loading': 'Loading',
      'status.ok': 'Connected',
      'status.interrupted': 'Connection lost',
      'load.failed': 'Could not read the settings: {reason}',
      'action.retry': 'Retry',
      'action.retryNow': 'Retry now',
      'action.openSite': 'Open site',
      'ok.balance': 'Balance',
      'ok.used': 'Used {used}',
      'ok.requests': '{count} requests',
      'ok.updated': 'updated {time}',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing',
      'action.topup': 'Top up',
      'ok.mounted': '{groups} groups · {models} models mounted',
      'ok.mountedNoModels': '{groups} groups mounted',
      'action.logout': 'Sign out',
      'logout.confirm': 'Sign out?',
      'action.cancel': 'Cancel',
      'ctx.title': 'Context window',
      'ctx.summary': 'Default {window} tokens · {rules} per-model rules',
      'ctx.edit': 'Edit',
      'ctx.collapse': 'Collapse',
      'ctx.desc': 'The Harness uses this window to decide when to compact history and whether a session can switch to a PIXEL model mid-conversation. The site does not publish per-model limits; adjust it here when a model differs.',
      'ctx.default': 'Default window (tokens)',
      'ctx.overrides': 'Per-model windows',
      'ctx.overrides.placeholder': 'One per line: model ID = tokens; end with * to match a prefix\ngemini-* = 1048576\nclaude-opus-5-5 = 1000000',
      'ctx.hint': 'An exact model ID beats a prefix and a longer prefix beats a shorter one, ignoring case; numbers may be written as 272k or 1m. Changes apply from the next request.',
      'ctx.save': 'Save',
      'ctx.saving': 'Saving…',
      'ctx.reset': 'Restore defaults',
      'ctx.saved': 'Saved',
      'err.ctx.default': 'The default window must be an integer above 65536 (Harness compaction reserves 65536 tokens by default).',
      'err.ctx.line': 'Line {line} is malformed: use "model ID = tokens" with an integer above 65536.',
      'err.ctx.star': 'Line {line}: a bare * would cover every model; change the default window instead.',
      'replay.title': 'GPT encrypted-reasoning passback',
      'replay.summary': 'May fail on multi-channel groups; off by default',
      'replay.desc': "When on, GPT models carry the previous step's encrypted reasoning into each tool-calling step, for more coherent reasoning. The site accepts it only from the upstream account that produced it: if a group has several channels and the site has no channel affinity for /pg/chat/completions, a request that moves to another account fails and the rest of this session's requests fail with it — turn this switch off to recover. Turn it on only after confirming the group has a single channel, or that the site has affinity configured.",
      'upd.title': 'Plugin version',
      'upd.idle': 'Nothing is checked in the background; Check for updates reads the newest version from GitHub',
      'upd.checking': 'Checking…',
      'upd.latest': 'Up to date',
      'upd.checkedAt': 'checked {time}',
      'upd.available': 'v{version} is available',
      'upd.availableHint': 'The plugin manager removes this version, then installs the new one; PIXEL models and this page disappear meanwhile. A failed installation restores this version.',
      'upd.unsupported': 'Newest is v{version}, but this copy cannot be updated here: {reason}',
      'upd.error': 'Checking for updates failed: {reason}',
      'upd.updating': 'Updating to v{version}; this page comes back when it finishes. Restart DeepSeek Harness if it does not.',
      'upd.updated': 'Updated to v{version}',
      'upd.restart': 'v{version} is installed and takes effect after restarting DeepSeek Harness',
      'upd.failed': 'The update failed: {reason}',
      'upd.check': 'Check for updates',
      'upd.apply': 'Update to v{version}',
      'upd.applying': 'Updating…',
      'upd.confirm': 'Confirm update',
      'picker.account': 'DeepSeek Account',
      'picker.loading': 'Loading models…',
      'picker.choose': 'Select model',
      'picker.title': 'Select model',
      'picker.search': 'Search models… (↑↓ to select, Alt+←→ to switch groups, Enter to confirm)',
      'picker.groups': 'Model groups',
      'picker.models': 'Models',
      'picker.refreshing': 'Refreshing model list…',
      'picker.noMatch': 'No matching groups',
      'picker.empty': 'No models available',
      'picker.groupEmpty': 'No models in this group',
      'picker.currentGroup': 'Group of the current model',
      'picker.groupId': 'ID: {id}',
      'picker.tip.id': 'ID: {id}',
      'picker.tip.ratio': 'Ratio: ×{ratio}',
      'picker.head.id': 'ID {id}',
      'picker.head.ratio': 'Ratio ×{ratio}',
      'picker.ratio.auto': 'auto',
      'picker.switching': 'Switching…',
      'picker.effort': 'Reasoning effort',
      'picker.defaultEffort': 'Default',
      'picker.catalogFailed': 'The model catalog failed to load: {reason}',
      'picker.groupFailed': '{group} failed to load: {reason}',
      'picker.writerHeld': 'Another DSH instance is using this session; quit it and try again',
      'picker.switchFailed': 'Switching failed: {reason}',
      'picker.unknownError': 'unknown error',
    }

    // Inline icons: 24-unit strokes in currentColor, hidden from assistive tech.
    const svgIcon = (size, ...shapes) => h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, ...shapes)
    const EyeIcon = () => svgIcon(16,
      h('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
      h('circle', { cx: 12, cy: 12, r: 3 }))
    const EyeOffIcon = () => svgIcon(16,
      h('path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' }),
      h('line', { x1: 1, y1: 1, x2: 23, y2: 23 }))
    const ShieldIcon = () => svgIcon(14, h('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }))
    const CheckIcon = () => svgIcon(12, h('polyline', { points: '20 6 9 17 4 12' }))
    const ArrowUpRightIcon = () => svgIcon(12, h('path', { d: 'M7 17 17 7' }), h('path', { d: 'M8 7h9v9' }))
    const AlertIcon = (props) => svgIcon(props.size || 14,
      h('circle', { cx: 12, cy: 12, r: 9 }),
      h('line', { x1: 12, y1: 8, x2: 12, y2: 12.5 }),
      h('line', { x1: 12, y1: 16, x2: 12.01, y2: 16 }))

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .pxa-section {
          --pxa-ease: cubic-bezier(0.2, 0, 0, 1);
          --pxa-fast: 120ms;
          --pxa-mid: 180ms;
          --pxa-slow: 240ms;
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 8px 0;
          color: var(--dsw-alias-label-primary);
          font-size: 13px;
          line-height: 22px;
        }
        .pxa-enter {
          animation: pxa-in var(--pxa-slow) var(--pxa-ease) both;
          animation-delay: calc(var(--pxa-i, 0) * 40ms);
        }
        .pxa-card {
          box-sizing: border-box;
          padding: 12px 16px;
          border: 0.5px solid var(--dsw-alias-settings-card-stroke);
          border-radius: var(--dsw-radius-xl);
          background: var(--dsw-alias-settings-card-fill);
        }
        .pxa-sr {
          position: absolute;
          width: 1px;
          height: 1px;
          margin: -1px;
          padding: 0;
          border: 0;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }

        .pxa-identity { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .pxa-who { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 44px; }
        .pxa-avatar {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          corner-shape: round;
          background: var(--dsw-alias-bg-skeleton);
          color: var(--dsw-alias-label-tertiary);
          font-size: 14px;
          font-weight: 500;
          line-height: 1;
        }
        .pxa-who-text { display: flex; flex-direction: column; min-width: 0; }
        .pxa-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 14px;
          font-weight: 500;
          line-height: 22px;
        }
        .pxa-who-sub {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          column-gap: 4px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
        }
        .pxa-conn { display: inline-flex; align-items: center; gap: 4px; }
        .pxa-dot {
          flex: none;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          corner-shape: round;
          background: var(--dsw-alias-state-success-primary);
        }
        .pxa-dot.warn { background: var(--dsw-alias-state-warn-primary); }
        .pxa-dot.pulse { animation: pxa-pulse ${PULSE_MS}ms var(--pxa-ease) ${PULSE_DELAY_MS}ms both; }
        .pxa-site-link {
          flex: none;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          border-radius: var(--dsw-radius-xs);
          color: var(--dsw-alias-label-secondary);
          font-size: 13px;
          line-height: 22px;
          text-decoration: none;
          transition: color var(--pxa-fast) var(--pxa-ease);
        }
        .pxa-site-link:hover { color: var(--dsw-alias-label-primary); }

        .pxa-balance { display: flex; flex-direction: column; gap: 8px; }
        .pxa-line {
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          min-height: 40px;
          padding: 6px 0;
        }
        .pxa-divider { border-top: 0.5px solid var(--dsw-alias-border-l2); }
        .pxa-amount {
          font-size: 16px;
          font-weight: 600;
          line-height: 24px;
          font-variant-numeric: tabular-nums;
          transition: opacity var(--pxa-mid) var(--pxa-ease);
        }
        .pxa-amount.dim { opacity: 0.45; }
        .pxa-meta {
          min-width: 0;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
          overflow-wrap: anywhere;
        }
        .pxa-meta.err { color: var(--dsw-alias-state-error-primary); }
        .pxa-actions {
          flex: none;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }

        .pxa-btn {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 32px;
          padding: 0 12px;
          border: 0.5px solid var(--dsw-alias-border-l3);
          border-radius: var(--dsw-radius-md);
          background: transparent;
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
          line-height: 20px;
          white-space: nowrap;
          text-decoration: none;
          cursor: pointer;
          transition: background-color var(--pxa-fast) var(--pxa-ease), transform var(--pxa-fast) var(--pxa-ease), opacity var(--pxa-fast) var(--pxa-ease);
        }
        .pxa-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .pxa-btn:active:not(:disabled) { transform: scale(0.98); }
        .pxa-btn:disabled { cursor: not-allowed; opacity: 0.4; }
        .pxa-btn[aria-busy='true']:disabled { cursor: progress; opacity: 0.85; }
        .pxa-btn.primary {
          border-color: transparent;
          background: var(--dsw-alias-button-primary-fill);
          color: var(--dsw-alias-label-primary-foreground);
          font-weight: 500;
        }
        .pxa-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
        .pxa-btn.danger { color: var(--dsw-alias-state-error-primary); }
        .pxa-btn.danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
        .pxa-btn.sm {
          height: 28px;
          padding: 0 10px;
          border-radius: var(--dsw-radius-sm);
          font-size: 12px;
          line-height: 18px;
        }
        .pxa-btn.block { width: 100%; height: 40px; font-size: 14px; line-height: 22px; }
        .pxa-text-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0;
          border: 0;
          border-radius: var(--dsw-radius-xs);
          background: none;
          color: var(--dsw-alias-label-secondary);
          font: inherit;
          font-size: 12px;
          line-height: 18px;
          cursor: pointer;
          transition: color var(--pxa-fast) var(--pxa-ease);
        }
        .pxa-text-btn.md { font-size: 13px; line-height: 20px; }
        .pxa-text-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
        .pxa-text-btn.danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
        .pxa-text-btn:disabled { cursor: not-allowed; opacity: 0.4; }
        .pxa-btn:focus-visible,
        .pxa-text-btn:focus-visible,
        .pxa-site-link:focus-visible,
        .pxa-switch:focus-visible,
        .pxa-eye:focus-visible {
          outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
          outline-offset: 2px;
        }

        .pxa-row + .pxa-row { border-top: 0.5px solid var(--dsw-alias-border-l2); }
        .pxa-row-main {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          min-height: 40px;
          padding: 8px 0;
        }
        .pxa-row-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
        .pxa-row-title { font-size: 14px; font-weight: 400; line-height: 22px; }
        .pxa-row-desc {
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
          overflow-wrap: anywhere;
        }
        .pxa-row-control { flex: none; display: flex; align-items: center; gap: 8px; }
        .pxa-tone.info { color: var(--dsw-alias-state-business-primary); }
        .pxa-tone.warn { color: var(--dsw-alias-state-warn-label); }
        .pxa-tone.err { color: var(--dsw-alias-state-error-primary); }
        .pxa-row-note {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          margin: 0;
          padding-bottom: 12px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
        }
        .pxa-row-note.warn { color: var(--dsw-alias-state-warn-label); }
        .pxa-row-note.err { color: var(--dsw-alias-state-error-primary); }
        .pxa-row-note svg,
        .pxa-msg svg,
        .pxa-login-foot svg { flex: none; margin-top: 2px; }

        .pxa-expand {
          display: grid;
          grid-template-rows: 0fr;
          margin: 0 -4px;
          opacity: 0;
          transition: grid-template-rows var(--pxa-slow) var(--pxa-ease), opacity var(--pxa-slow) var(--pxa-ease);
        }
        .pxa-expand.open { grid-template-rows: 1fr; opacity: 1; }
        .pxa-expand-inner {
          min-height: 0;
          overflow: hidden;
          padding: 0 4px;
          visibility: hidden;
          transition: visibility 0s linear var(--pxa-slow);
        }
        .pxa-expand.open > .pxa-expand-inner { visibility: visible; transition-delay: 0s; }
        .pxa-expand.drop > .pxa-expand-inner > * {
          transform: translateY(-4px);
          transition: transform var(--pxa-slow) var(--pxa-ease);
        }
        .pxa-expand.drop.open > .pxa-expand-inner > * { transform: none; }

        .pxa-edit { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 16px; }
        .pxa-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .pxa-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
        .pxa-input,
        .pxa-textarea {
          box-sizing: border-box;
          width: 100%;
          border: 0.5px solid var(--dsw-alias-border-l3);
          border-radius: var(--dsw-radius-md);
          background: var(--dsw-alias-bg-layer-3);
          color: var(--dsw-alias-label-primary);
          font: inherit;
          outline: none;
          transition: border-color 150ms var(--pxa-ease), box-shadow 150ms var(--pxa-ease), opacity 150ms var(--pxa-ease);
        }
        .pxa-input { height: 36px; padding: 0 12px; font-size: 13px; line-height: 20px; }
        .pxa-textarea {
          min-height: 96px;
          padding: 8px 12px;
          resize: vertical;
          font-family: var(--dsw-font-mono, var(--ds-font-family-code));
          font-size: 12px;
          line-height: 20px;
        }
        .pxa-input::placeholder,
        .pxa-textarea::placeholder { color: var(--dsw-alias-label-dimmed); opacity: 1; }
        .pxa-input:focus,
        .pxa-textarea:focus {
          border-color: var(--dsw-alias-state-business-primary);
          box-shadow: 0 0 0 var(--dsw-focus-ring-width) color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 20%, transparent);
        }
        .pxa-input[aria-invalid='true'],
        .pxa-textarea[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
        .pxa-input[aria-invalid='true']:focus,
        .pxa-textarea[aria-invalid='true']:focus {
          box-shadow: 0 0 0 var(--dsw-focus-ring-width) color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent);
        }
        .pxa-input:disabled,
        .pxa-textarea:disabled { cursor: not-allowed; opacity: 0.6; }
        .pxa-input.narrow { width: 160px; font-variant-numeric: tabular-nums; }
        .pxa-field-err,
        .pxa-hint { margin: 0; font-size: 12px; line-height: 18px; }
        .pxa-field-err { color: var(--dsw-alias-state-error-primary); }
        .pxa-hint { color: var(--dsw-alias-label-tertiary); }
        .pxa-edit-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .pxa-saved {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-left: 4px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-state-success-primary);
          animation: pxa-flash ${SAVED_NOTICE_MS}ms var(--pxa-ease) both;
        }

        .pxa-switch {
          box-sizing: border-box;
          flex: none;
          width: 36px;
          height: 20px;
          padding: 2px;
          border: 0;
          border-radius: 999px;
          corner-shape: round;
          background: var(--dsw-alias-border-l3);
          cursor: pointer;
          transition: background-color var(--pxa-mid) var(--pxa-ease);
        }
        .pxa-switch.on { background: var(--dsw-alias-brand-primary); }
        .pxa-switch[aria-busy='true'] { cursor: progress; }
        .pxa-switch-knob {
          display: block;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          corner-shape: round;
          background: var(--dsw-alias-switch-thumb);
          transition: transform var(--pxa-mid) var(--pxa-ease), background-color var(--pxa-mid) var(--pxa-ease);
        }
        .pxa-switch.on .pxa-switch-knob {
          transform: translateX(16px);
          background: var(--dsw-alias-label-primary-foreground);
        }

        .pxa-notice { display: flex; align-items: center; gap: 10px; }
        .pxa-notice-icon { flex: none; display: inline-flex; color: var(--dsw-alias-state-warn-primary); }
        .pxa-notice-icon.err { color: var(--dsw-alias-state-error-primary); }
        .pxa-notice-text { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

        .pxa-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          min-height: 28px;
          padding: 0 16px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
        }
        .pxa-footer-err { color: var(--dsw-alias-state-error-primary); }
        .pxa-confirm {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          animation: pxa-fade var(--pxa-slow) var(--pxa-ease) both;
        }

        .pxa-skel {
          position: relative;
          display: block;
          overflow: hidden;
          border-radius: var(--dsw-radius-xs);
          background: var(--dsw-alias-bg-skeleton);
        }
        .pxa-skel.circle {
          flex: none;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          corner-shape: round;
        }
        .pxa-skel::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent, var(--dsw-alias-bg-skeleton), transparent);
          transform: translateX(-100%);
          animation: pxa-shimmer 1.2s ease-in-out infinite;
        }
        .pxa-skel-lines { display: flex; flex-direction: column; gap: 8px; }

        .pxa-login { padding: 20px 24px; }
        .pxa-step { display: flex; flex-direction: column; gap: 16px; max-width: 400px; }
        .pxa-step.fwd { animation: pxa-from-right var(--pxa-slow) var(--pxa-ease) both; }
        .pxa-step.back { animation: pxa-from-left var(--pxa-slow) var(--pxa-ease) both; }
        .pxa-login-head { display: flex; flex-direction: column; gap: 2px; }
        .pxa-login-title { margin: 0; font-size: 15px; font-weight: 500; line-height: 22px; }
        .pxa-login-sub {
          margin: 0;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
          overflow-wrap: anywhere;
        }
        .pxa-form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
        .pxa-pass { position: relative; }
        .pxa-pass .pxa-input { padding-right: 40px; }
        .pxa-eye {
          position: absolute;
          top: 4px;
          right: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
          border: 0;
          border-radius: var(--dsw-radius-sm);
          background: transparent;
          color: var(--dsw-alias-label-tertiary);
          cursor: pointer;
          transition: color var(--pxa-fast) var(--pxa-ease), background-color var(--pxa-fast) var(--pxa-ease);
        }
        .pxa-eye:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
        .pxa-eye:disabled { cursor: not-allowed; opacity: 0.6; }
        .pxa-msg {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          margin: 0;
          padding-bottom: 10px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-state-error-primary);
        }
        .pxa-msg.info { color: var(--dsw-alias-label-secondary); }
        .pxa-slow {
          margin: 0;
          padding-top: 8px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
        }
        .pxa-login-foot {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          margin: 0;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary);
        }
        .pxa-otp {
          max-width: 240px;
          height: 48px;
          padding: 0 0 0 0.5em;
          font-family: var(--dsw-font-mono, var(--ds-font-family-code));
          font-size: 20px;
          letter-spacing: 0.5em;
          text-align: center;
          font-variant-numeric: tabular-nums;
        }
        .pxa-otp-actions { display: flex; align-items: center; gap: 16px; }
        .pxa-otp-actions .pxa-btn.block { width: 240px; }

        .pxa-spin { flex: none; animation: pxa-rotate 0.8s linear infinite; }
        .pxa-shake { animation: pxa-shake ${SHAKE_MS}ms var(--pxa-ease); }

        @keyframes pxa-in { from { opacity: 0; transform: translateY(6px); } }
        @keyframes pxa-fade { from { opacity: 0; } }
        @keyframes pxa-from-right { from { opacity: 0; transform: translateX(12px); } }
        @keyframes pxa-from-left { from { opacity: 0; transform: translateX(-12px); } }
        @keyframes pxa-shake {
          0%, 100% { transform: none; }
          20% { transform: translateX(-4px); }
          40% { transform: translateX(4px); }
          60% { transform: translateX(-3px); }
          80% { transform: translateX(2px); }
        }
        @keyframes pxa-rotate { to { transform: rotate(360deg); } }
        @keyframes pxa-shimmer { to { transform: translateX(100%); } }
        @keyframes pxa-pulse {
          from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, transparent); }
          to { box-shadow: 0 0 0 6px transparent; }
        }
        @keyframes pxa-flash {
          0% { opacity: 0; }
          11%, 89% { opacity: 1; }
          100% { opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .pxa-enter,
          .pxa-step.fwd,
          .pxa-step.back,
          .pxa-confirm { animation: pxa-fade var(--pxa-fast) linear both; animation-delay: 0s; }
          .pxa-shake,
          .pxa-dot.pulse,
          .pxa-spin,
          .pxa-skel::after { animation: none; }
          .pxa-btn:active:not(:disabled) { transform: none; }
          .pxa-switch-knob { transition: background-color var(--pxa-mid) var(--pxa-ease); }
          .pxa-expand { transition: opacity var(--pxa-fast) linear; }
          .pxa-expand-inner { transition: none; }
          .pxa-expand.drop > .pxa-expand-inner > * { transform: none; transition: none; }
        }
      `
      document.head.appendChild(style)
      return () => style.remove()
    }

    const msg = (e) => (e && e.message) ? e.message : String(e)
    const authOf = (section) => (section && section.auth) ? section.auth : { state: 'none', message: '', user: '', groups: [], models: -1 }
    const fillText = (t, key, vars) => Object.entries(vars).reduce(
      (text, [k, v]) => text.split('{' + k + '}').join(String(v)), t(key))
    // 22:20, or 11-20 22:20 with the date.
    const formatTime = (ms, withDate) => {
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      const time = pad(d.getHours()) + ':' + pad(d.getMinutes())
      return withDate ? pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + time : time
    }

    // Context window settings. The host declares `contextWindow`, or the best
    // matching `contextWindows` rule, as each PIXEL model's capacity; Harness
    // compaction and its model-switch check price history against it. A value
    // at or below the 65536-token compaction headroom would still refuse every
    // switch, so the page rejects it (the patch file can go lower).
    const DEFAULT_CONTEXT_WINDOW = 272000
    const MIN_CONTEXT_WINDOW = 65537

    // "272000", "272,000", "272_000", "272k", "1m", "1.5m" → integer tokens.
    function parseTokens(text) {
      const s = String(text).trim().toLowerCase().replace(/[,_\s]/g, '')
      const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s)
      if (!m) return undefined
      const n = Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : 1)
      return Number.isSafeInteger(n) ? n : undefined
    }

    const formatRules = (rules) => Object.entries(rules || {}).map(([k, v]) => k + ' = ' + v).join('\n')

    // One rule per line, `<model id or prefix*> = <tokens>`; blank lines and
    // `#` comments are skipped, and a repeated id (ignoring case) keeps the
    // last line. Returns { rules } or { error }.
    function parseRules(text, t) {
      const rules = {}
      const lines = String(text).split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line || line.startsWith('#')) continue
        const at = line.lastIndexOf('=')
        const key = at > 0 ? line.slice(0, at).trim() : ''
        const tokens = at > 0 ? parseTokens(line.slice(at + 1)) : undefined
        if (!key || tokens === undefined || tokens < MIN_CONTEXT_WINDOW) {
          return { error: fillText(t, 'err.ctx.line', { line: i + 1 }) }
        }
        if (key === '*') return { error: fillText(t, 'err.ctx.star', { line: i + 1 }) }
        for (const existing of Object.keys(rules)) {
          if (existing.toLowerCase() === key.toLowerCase()) delete rules[existing]
        }
        rules[key] = tokens
      }
      return { rules }
    }

    function Spinner(props) {
      const size = props.size || 14
      return h('svg', { className: 'pxa-spin', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.5, opacity: 0.25 }),
        h('path', { d: 'M21 12a9 9 0 0 0-9-9', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' }))
    }

    // Height-animated disclosure (grid rows 0fr ↔ 1fr, with a fade). While
    // closing it keeps the content it last showed, so that content folds
    // away instead of vanishing first. Other props (id, role) go on the
    // outer element, which always renders and can carry a live region.
    function Expand(props) {
      const { open, className, children, ...rest } = props
      const shown = useRef(null)
      if (open) shown.current = children
      return h('div', { ...rest, className: 'pxa-expand' + (open ? ' open' : '') + (className ? ' ' + className : '') },
        h('div', { className: 'pxa-expand-inner' }, shown.current))
    }

    // A flag that plays a one-shot animation (a shake, the status-dot pulse)
    // while it is up. The element's animationend drops it, and so does a timer
    // of the animation's length: under prefers-reduced-motion the animation is
    // `none` and animationend never fires, nor does it for a run cut short
    // when the element loses its class.
    function useOneShot(ms) {
      const [on, setOn] = useState(false)
      useEffect(() => {
        if (!on) return undefined
        const timer = setTimeout(() => setOn(false), ms)
        return () => clearTimeout(timer)
      }, [on, ms])
      return [on, setOn]
    }

    // A settings row: title and one line of description on the left, the
    // control on the right, optional folding content (children) below.
    function SettingRow(props) {
      const { title, desc, control, labelId, live, children } = props
      return h('div', { className: 'pxa-row' },
        h('div', { className: 'pxa-row-main' },
          h('div', { className: 'pxa-row-text' },
            h('span', { className: 'pxa-row-title', id: labelId }, title),
            h('span', { className: 'pxa-row-desc', id: labelId ? labelId + '-desc' : undefined, role: live ? 'status' : undefined }, desc)),
          h('div', { className: 'pxa-row-control' }, control)),
        children)
    }

    function ContextRow(props) {
      const { api, t, section, reload } = props
      const stored = Number(section && section.contextWindow)
      const currentWindow = Number.isSafeInteger(stored) && stored > 0 ? stored : DEFAULT_CONTEXT_WINDOW
      const storedRules = section && section.contextWindows
      const currentRules = storedRules && typeof storedRules === 'object' ? storedRules : {}
      const sourceKey = currentWindow + '\n' + formatRules(currentRules)
      const fresh = () => ({ window: String(currentWindow), rules: formatRules(currentRules), dirty: false, source: sourceKey })
      const [form, setForm] = useState(fresh)
      const [open, setOpen] = useState(false)
      const [saving, setSaving] = useState(false)
      // { field: 'window' | 'rules' | 'save', text }
      const [error, setError] = useState(null)
      // When the last save landed (0: no 「已保存」 on screen).
      const [savedAt, setSavedAt] = useState(0)
      const [shaking, setShaking] = useOneShot(SHAKE_MS)
      const id = useId()

      // Follow the stored value until the user edits: a host status write
      // landing mid-edit must not wipe what they typed.
      useEffect(() => {
        setForm((f) => (f.dirty || f.source === sourceKey ? f : fresh()))
      }, [sourceKey])
      useEffect(() => {
        if (!savedAt) return undefined
        const timer = setTimeout(() => setSavedAt(0), SAVED_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [savedAt])

      const commit = async (windowValue, rules) => {
        setSaving(true)
        setError(null)
        setSavedAt(0)
        try {
          await api.settings.mutate(NS, [
            { op: 'set', path: ['contextWindow'], value: windowValue },
            { op: 'set', path: ['contextWindows'], value: rules },
          ])
          const text = formatRules(rules)
          setForm({ window: String(windowValue), rules: text, dirty: false, source: windowValue + '\n' + text })
          setSavedAt(Date.now())
          // Refetch the section so the summary shows the stored value even if
          // no settings/document-updated event reaches this page.
          if (typeof reload === 'function') void reload()
        } catch (e) {
          setError({ field: 'save', text: msg(e) })
        } finally {
          setSaving(false)
        }
      }
      const reject = (field, text) => {
        setSavedAt(0)
        setError({ field, text })
        setShaking(true)
      }
      const save = () => {
        const windowValue = parseTokens(form.window)
        if (windowValue === undefined || windowValue < MIN_CONTEXT_WINDOW) {
          reject('window', t('err.ctx.default'))
          return
        }
        const parsed = parseRules(form.rules, t)
        if (parsed.error) {
          reject('rules', parsed.error)
          return
        }
        void commit(windowValue, parsed.rules)
      }
      const edit = (field, value) => {
        setSavedAt(0)
        setError((e) => (e !== null && (e.field === field || e.field === 'save') ? null : e))
        setForm((f) => ({ ...f, [field]: value, dirty: true }))
      }
      const invalid = (field) => error !== null && error.field === field
      const errorLine = (field) => (invalid(field) ? h('p', { id: id + '-err', className: 'pxa-field-err' }, error.text) : null)
      const ruleCount = Object.keys(currentRules).length
      const isDefault = currentWindow === DEFAULT_CONTEXT_WINDOW && ruleCount === 0

      return h(SettingRow, {
        title: t('ctx.title'),
        desc: fillText(t, 'ctx.summary', { window: currentWindow.toLocaleString(), rules: ruleCount }),
        control: h('button', {
          type: 'button',
          className: 'pxa-btn',
          'aria-expanded': open,
          'aria-controls': id + '-edit',
          onClick: () => setOpen((v) => !v),
        }, open ? t('ctx.collapse') : t('ctx.edit')),
      },
        h(Expand, { open, id: id + '-edit' },
          h('div', {
            className: 'pxa-edit' + (shaking ? ' pxa-shake' : ''),
            onAnimationEnd: (e) => { if (e.target === e.currentTarget) setShaking(false) },
          },
            h('p', { className: 'pxa-hint' }, t('ctx.desc')),
            h('div', { className: 'pxa-field' },
              h('label', { className: 'pxa-label', htmlFor: id + '-window' }, t('ctx.default')),
              h('input', {
                id: id + '-window',
                className: 'pxa-input narrow',
                value: form.window,
                inputMode: 'numeric',
                placeholder: String(DEFAULT_CONTEXT_WINDOW),
                disabled: saving,
                'aria-invalid': invalid('window'),
                'aria-describedby': invalid('window') ? id + '-err' : undefined,
                onChange: (e) => edit('window', e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !saving && form.dirty) save() },
              }),
              errorLine('window')),
            h('div', { className: 'pxa-field' },
              h('label', { className: 'pxa-label', htmlFor: id + '-rules' }, t('ctx.overrides')),
              h('textarea', {
                id: id + '-rules',
                className: 'pxa-textarea',
                rows: 4,
                value: form.rules,
                placeholder: t('ctx.overrides.placeholder'),
                spellCheck: false,
                disabled: saving,
                'aria-invalid': invalid('rules'),
                'aria-describedby': invalid('rules') ? id + '-err' : undefined,
                onChange: (e) => edit('rules', e.target.value),
              }),
              errorLine('rules'),
              h('p', { className: 'pxa-hint' }, t('ctx.hint'))),
            h('div', { className: 'pxa-edit-actions' },
              h('button', {
                type: 'button',
                className: 'pxa-btn primary',
                disabled: saving || !form.dirty,
                'aria-busy': saving,
                onClick: save,
              }, saving ? h(Spinner) : null, saving ? t('ctx.saving') : t('ctx.save')),
              h('button', {
                type: 'button',
                className: 'pxa-btn',
                disabled: saving || (isDefault && !form.dirty),
                onClick: () => void commit(DEFAULT_CONTEXT_WINDOW, {}),
              }, t('ctx.reset')),
              savedAt ? h('span', { key: savedAt, className: 'pxa-saved', role: 'status' }, h(CheckIcon), t('ctx.saved')) : null),
            errorLine('save'))))
    }

    // GPT encrypted-reasoning passback. Off by default: the host sends the
    // site's replay token back only when this is on (index.js serializeAssistant).
    // The toggle writes the volatile `openaiReasoningReplay` field; the host
    // reads it live, so it applies from the next request without a reload.
    function ReplayRow(props) {
      const { api, t, section, reload } = props
      const stored = !!(section && section.openaiReasoningReplay)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      // Intended value while a write is in flight; null follows the stored one.
      const [optimistic, setOptimistic] = useState(null)
      const id = useId()
      const on = optimistic === null ? stored : optimistic
      useEffect(() => {
        if (optimistic !== null && optimistic === stored) setOptimistic(null)
      }, [stored, optimistic])

      const toggle = () => {
        if (busy) return
        const value = !on
        setBusy(true)
        setError(null)
        setOptimistic(value)
        api.settings.mutate(NS, [{ op: 'set', path: ['openaiReasoningReplay'], value }])
          .then(() => { if (typeof reload === 'function') void reload() },
            (e) => { setOptimistic(null); setError(msg(e)) })
          .finally(() => setBusy(false))
      }

      return h(SettingRow, {
        title: t('replay.title'),
        desc: t('replay.summary'),
        labelId: id,
        control: h('button', {
          type: 'button',
          className: 'pxa-switch' + (on ? ' on' : ''),
          role: 'switch',
          'aria-checked': on,
          'aria-labelledby': id,
          'aria-describedby': id + '-desc',
          'aria-busy': busy,
          onClick: toggle,
        }, h('span', { className: 'pxa-switch-knob' })),
      },
        h(Expand, { open: on },
          h('p', { className: 'pxa-row-note warn' }, h(AlertIcon), h('span', null, t('replay.desc')))),
        h(Expand, { open: error !== null, role: 'status' },
          h('p', { className: 'pxa-row-note err' }, error)))
    }

    // Plugin version and updates. The host does the work (it reads release
    // tags with git and runs the plugin manager's update); this row only bumps
    // updateCheckAt / updateApplyAt and renders the `update` status the host
    // writes back. Nothing is checked unless the person asks.
    function VersionRow(props) {
      const { api, t, section, reload } = props
      const u = (section && section.update) || {}
      const state = String(u.state || 'idle')
      const [confirming, setConfirming] = useState(false)
      const [sent, setSent] = useState(null)
      const [error, setError] = useState(null)
      const id = useId()
      // A request is pending until the host records serving it.
      const servedFor = (kind) => Number(kind === 'check' ? u.servedCheckAt : u.servedApplyAt) || 0
      const pending = sent !== null && sent.at > servedFor(sent.kind)
      useEffect(() => {
        if (!pending) return undefined
        // Poll as well, in case no settings/document-updated event reaches this page.
        const poll = setInterval(() => { if (typeof reload === 'function') void reload() }, HOST_POLL_MS)
        const giveUp = setTimeout(() => setSent(null), HOST_WAIT_MS)
        return () => { clearInterval(poll); clearTimeout(giveUp) }
      }, [pending, reload])
      const checking = state === 'checking' || (pending && sent.kind === 'check')
      const applying = state === 'updating' || (pending && sent.kind === 'apply')
      const request = (kind) => {
        const at = Date.now()
        setError(null)
        setConfirming(false)
        setSent({ kind, at })
        api.settings.mutate(NS, [{ op: 'set', path: [kind === 'check' ? 'updateCheckAt' : 'updateApplyAt'], value: at }])
          .catch((e) => { setSent(null); setError(msg(e)) })
      }

      const reason = u.message || '—'
      let status = t('upd.idle')
      let tone = ''
      if (error) { status = error; tone = 'err' }
      else if (checking) status = t('upd.checking')
      else if (state === 'latest') status = t('upd.latest')
      else if (state === 'available') { status = fillText(t, 'upd.available', { version: u.latest }); tone = 'info' }
      else if (state === 'unsupported') { status = fillText(t, 'upd.unsupported', { version: u.latest, reason }); tone = 'warn' }
      else if (state === 'error') { status = fillText(t, 'upd.error', { reason }); tone = 'err' }
      else if (state === 'updating') status = fillText(t, 'upd.updating', { version: u.target })
      else if (state === 'updated') status = fillText(t, 'upd.updated', { version: u.current })
      else if (state === 'restart') { status = fillText(t, 'upd.restart', { version: u.target }); tone = 'warn' }
      else if (state === 'failed') { status = fillText(t, 'upd.failed', { reason }); tone = 'err' }
      const checkedAt = Number(u.checkedAt) || 0
      const stamp = checkedAt > 0 && !error && !checking && (state === 'latest' || state === 'available')
        ? fillText(t, 'upd.checkedAt', { time: formatTime(checkedAt, true) })
        : ''
      const available = state === 'available' && !!u.latest

      let control
      if (applying) {
        control = h('button', { type: 'button', className: 'pxa-btn', disabled: true, 'aria-busy': true },
          h(Spinner), t('upd.applying'))
      } else if (available && confirming) {
        control = h(React.Fragment, null,
          h('button', { type: 'button', className: 'pxa-btn primary', 'aria-describedby': id + '-hint', onClick: () => request('apply') },
            t('upd.confirm')),
          h('button', { type: 'button', className: 'pxa-btn', onClick: () => setConfirming(false) }, t('action.cancel')))
      } else if (available) {
        control = h('button', { type: 'button', className: 'pxa-btn primary', onClick: () => setConfirming(true) },
          fillText(t, 'upd.apply', { version: u.latest }))
      } else {
        control = h('button', {
          type: 'button',
          className: 'pxa-btn',
          disabled: checking,
          'aria-busy': checking,
          onClick: () => request('check'),
        }, checking ? h(Spinner) : null, t('upd.check'))
      }

      return h(SettingRow, {
        title: t('upd.title'),
        live: true,
        desc: h(React.Fragment, null,
          u.current && state !== 'updated' ? 'v' + u.current + ' · ' : null,
          h('span', { className: tone ? 'pxa-tone ' + tone : undefined }, status),
          stamp ? ' · ' + stamp : null),
        control,
      },
        h(Expand, { open: available && confirming && !applying },
          h('p', { id: id + '-hint', className: 'pxa-row-note' }, t('upd.availableHint'))))
    }

    function IdentityCard(props) {
      const { t, name, detail, connected, pulse, onPulseEnd } = props
      const initial = Array.from(name)[0] || ''
      return h('div', { className: 'pxa-card pxa-identity' },
        h('div', { className: 'pxa-who' },
          h('span', { className: 'pxa-avatar', 'aria-hidden': true }, initial.toUpperCase()),
          h('div', { className: 'pxa-who-text' },
            h('span', { className: 'pxa-name' }, name || '—'),
            h('span', { className: 'pxa-who-sub' },
              detail ? h('span', null, detail) : null,
              detail ? h('span', { 'aria-hidden': true }, '·') : null,
              h('span', { className: 'pxa-conn', role: 'status' },
                h('span', {
                  className: 'pxa-dot' + (connected ? '' : ' warn') + (pulse ? ' pulse' : ''),
                  onAnimationEnd: onPulseEnd,
                }),
                connected ? t('status.ok') : t('status.interrupted'))))),
        h('a', { className: 'pxa-site-link', href: SITE_URL + '/', target: '_blank', rel: 'noreferrer' },
          t('action.openSite'), h(ArrowUpRightIcon)))
    }

    function BalanceCard(props) {
      const { t, profile, refreshing, error, onRefresh } = props
      const usage = profile.updatedAt
        ? [
          profile.used ? fillText(t, 'ok.used', { used: profile.used }) : '',
          fillText(t, 'ok.requests', { count: Number(profile.requests || 0).toLocaleString() }),
          fillText(t, 'ok.updated', { time: formatTime(profile.updatedAt, false) }),
        ].filter(Boolean).join(' · ')
        : ''
      return h('div', { className: 'pxa-card pxa-balance' },
        h('div', { className: 'pxa-line' },
          h('span', null, t('ok.balance')),
          h('span', { className: 'pxa-amount' + (refreshing ? ' dim' : '') }, profile.balance || '—')),
        h('div', { className: 'pxa-divider' }),
        h('div', { className: 'pxa-line' },
          h('span', { className: 'pxa-meta' + (error ? ' err' : ''), role: 'status' }, error || usage),
          h('div', { className: 'pxa-actions' },
            h('button', {
              type: 'button',
              className: 'pxa-btn',
              disabled: refreshing,
              'aria-busy': refreshing,
              onClick: onRefresh,
            }, refreshing ? h(Spinner) : null, refreshing ? t('action.refreshing') : t('action.refresh')),
            h('a', { className: 'pxa-btn primary', href: SITE_URL + '/wallet', target: '_blank', rel: 'noreferrer' },
              t('action.topup')))))
    }

    // One line of status with one action: the settings read failing, or the
    // session kept while the site cannot be reached.
    function NoticeCard(props) {
      const { tone, text, action, busy, onAction } = props
      return h('div', { className: 'pxa-card pxa-notice' },
        h('span', { className: 'pxa-notice-icon ' + tone }, h(AlertIcon, { size: 16 })),
        h('span', { className: 'pxa-notice-text', role: 'status' }, text),
        h('button', { type: 'button', className: 'pxa-btn', disabled: busy, 'aria-busy': busy, onClick: onAction },
          busy ? h(Spinner) : null, action))
    }

    function AccountFooter(props) {
      const { t, mounted, busy, error, onSignOut } = props
      // idle → confirm; cancelling returns to the trigger with focus on it.
      const [mode, setMode] = useState('idle')
      return h('div', { className: 'pxa-footer' },
        h('span', { className: error ? 'pxa-footer-err' : undefined, role: 'status' }, error || mounted),
        mode === 'confirm'
          ? h('div', { className: 'pxa-confirm' },
            h('span', null, t('logout.confirm')),
            h('button', {
              type: 'button',
              className: 'pxa-btn sm danger',
              disabled: busy,
              'aria-busy': busy,
              onClick: onSignOut,
            }, busy ? h(Spinner, { size: 12 }) : null, t('action.logout')),
            h('button', { type: 'button', className: 'pxa-btn sm', disabled: busy, autoFocus: true, onClick: () => setMode('cancelled') },
              t('action.cancel')))
          : h('button', {
            type: 'button',
            className: 'pxa-text-btn danger',
            autoFocus: mode === 'cancelled',
            onClick: () => setMode('confirm'),
          }, t('action.logout')))
    }

    // Login card: the password step, and the TOTP step of a 2FA challenge in
    // the same frame. Progress comes from the parent (`signingIn`,
    // `verifying`); `failures` counts sign-ins from this page that came back
    // with an error, each of which shakes the card and asks for the password.
    function LoginCard(props) {
      const {
        t, step, initialUsername, user, message, signingIn, verifying, cancelling, failures,
        onLogin, onVerify, onBack,
      } = props
      const [form, setForm] = useState(() => ({ username: initialUsername, password: '', otp: '' }))
      const [missing, setMissing] = useState({ username: false, password: false })
      const [showPassword, setShowPassword] = useState(false)
      const [shaking, setShaking] = useOneShot(SHAKE_MS)
      const [slow, setSlow] = useState(false)
      // The step on screen, and how the latest step change slides in.
      const [shownStep, setShownStep] = useState(step)
      const [slide, setSlide] = useState('')
      const seenFailures = useRef(failures)
      const usernameRef = useRef(null)
      const passwordRef = useRef(null)
      const id = useId()

      if (shownStep !== step) {
        setShownStep(step)
        setSlide(step === 'otp' ? 'fwd' : 'back')
      }
      useEffect(() => {
        setSlow(false)
        if (!signingIn) return undefined
        const timer = setTimeout(() => setSlow(true), SLOW_SIGN_IN_MS)
        return () => clearTimeout(timer)
      }, [signingIn])
      useEffect(() => {
        if (failures === seenFailures.current) return
        seenFailures.current = failures
        setShaking(true)
        setForm((f) => ({ ...f, password: '', otp: '' }))
        if (passwordRef.current) passwordRef.current.focus()
      }, [failures])

      const change = (field) => (e) => {
        const value = e.target.value
        setForm((f) => ({ ...f, [field]: value }))
        setMissing((m) => (m[field] ? { ...m, [field]: false } : m))
      }
      const submitLogin = (e) => {
        e.preventDefault()
        if (signingIn) return
        const name = form.username.trim()
        const absent = { username: name === '', password: form.password === '' }
        if (absent.username || absent.password) {
          setMissing(absent)
          setShaking(true)
          const first = absent.username ? usernameRef.current : passwordRef.current
          if (first) first.focus()
          return
        }
        // The host holds the password from here on; drop it from the field.
        void onLogin(name, form.password).then(() => setForm((f) => ({ ...f, password: '' })))
      }
      const submitOtp = (code) => {
        if (verifying || cancelling || code.length < OTP_LENGTH) return
        void onVerify(code)
      }
      const typeOtp = (e) => {
        const code = e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH)
        setForm((f) => ({ ...f, otp: code }))
        if (code.length === OTP_LENGTH) submitOtp(code)
      }
      const back = () => {
        setForm((f) => ({ ...f, otp: '' }))
        void onBack()
      }

      const messageId = id + '-msg'
      const messageLine = message
        ? h('p', { id: messageId, className: 'pxa-msg' + (message.tone === 'info' ? ' info' : '') },
          h(AlertIcon), h('span', null, message.text))
        : null
      const head = (title, sub) => h('div', { className: 'pxa-login-head' },
        h('h2', { className: 'pxa-login-title' }, title),
        h('p', { className: 'pxa-login-sub' }, sub))
      const stepClass = 'pxa-step' + (slide ? ' ' + slide : '')

      let content
      if (step === 'otp') {
        content = h('div', { key: 'otp', className: stepClass },
          head(t('otp.title'), fillText(t, 'otp.subtitle', { user })),
          h('form', { className: 'pxa-form', onSubmit: (e) => { e.preventDefault(); submitOtp(form.otp) } },
            h('input', {
              className: 'pxa-input pxa-otp',
              value: form.otp,
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              autoFocus: true,
              maxLength: OTP_LENGTH,
              disabled: verifying || cancelling,
              'aria-label': t('field.otp'),
              'aria-describedby': message ? messageId : undefined,
              onChange: typeOtp,
            }),
            h('div', null,
              h(Expand, { open: message !== null, className: 'drop', role: 'status' }, messageLine),
              h('div', { className: 'pxa-otp-actions' },
                h('button', {
                  type: 'submit',
                  className: 'pxa-btn primary block',
                  disabled: verifying || cancelling || form.otp.length < OTP_LENGTH,
                  'aria-busy': verifying,
                }, verifying ? h(Spinner) : null, verifying ? t('action.verifying') : t('action.verify')),
                h('button', {
                  type: 'button',
                  className: 'pxa-text-btn md',
                  disabled: verifying || cancelling,
                  'aria-busy': cancelling,
                  onClick: back,
                }, t('action.back'))))))
      } else {
        content = h('div', { key: 'password', className: stepClass },
          head(t('login.title'), fillText(t, 'login.subtitle', { site: SITE_HOST })),
          h('form', { className: 'pxa-form', onSubmit: submitLogin },
            h('div', { className: 'pxa-field' },
              h('label', { className: 'pxa-label', htmlFor: id + '-user' }, t('field.username')),
              h('input', {
                ref: usernameRef,
                id: id + '-user',
                className: 'pxa-input',
                name: 'username',
                value: form.username,
                autoComplete: 'username',
                autoCapitalize: 'off',
                spellCheck: false,
                disabled: signingIn,
                'aria-invalid': missing.username,
                'aria-describedby': missing.username ? id + '-user-err' : undefined,
                onChange: change('username'),
              }),
              missing.username ? h('p', { id: id + '-user-err', className: 'pxa-field-err' }, t('err.username')) : null),
            h('div', { className: 'pxa-field' },
              h('label', { className: 'pxa-label', htmlFor: id + '-pass' }, t('field.password')),
              h('div', { className: 'pxa-pass' },
                h('input', {
                  ref: passwordRef,
                  id: id + '-pass',
                  className: 'pxa-input',
                  name: 'password',
                  type: showPassword ? 'text' : 'password',
                  value: form.password,
                  autoComplete: 'current-password',
                  autoFocus: slide === 'back',
                  disabled: signingIn,
                  'aria-invalid': missing.password,
                  'aria-describedby': [
                    missing.password ? id + '-pass-err' : '',
                    message && message.tone === 'err' ? messageId : '',
                  ].filter(Boolean).join(' ') || undefined,
                  onChange: change('password'),
                }),
                h('button', {
                  type: 'button',
                  className: 'pxa-eye',
                  title: showPassword ? t('action.hidePassword') : t('action.showPassword'),
                  'aria-label': showPassword ? t('action.hidePassword') : t('action.showPassword'),
                  disabled: signingIn,
                  onClick: () => setShowPassword((v) => !v),
                }, showPassword ? h(EyeOffIcon) : h(EyeIcon))),
              missing.password ? h('p', { id: id + '-pass-err', className: 'pxa-field-err' }, t('err.password')) : null),
            h('div', null,
              h(Expand, { open: message !== null, className: 'drop', role: 'status' }, messageLine),
              h('button', { type: 'submit', className: 'pxa-btn primary block', disabled: signingIn, 'aria-busy': signingIn },
                signingIn ? h(Spinner) : null, signingIn ? t('action.loggingIn') : t('action.login')),
              h(Expand, { open: signingIn && slow, role: 'status' },
                h('p', { className: 'pxa-slow' }, t('login.slow'))))),
          h('p', { className: 'pxa-login-foot' }, h(ShieldIcon), h('span', null, t('hint.session'))))
      }

      return h('div', {
        className: 'pxa-card pxa-login' + (shaking ? ' pxa-shake' : ''),
        onAnimationEnd: (e) => { if (e.target === e.currentTarget) setShaking(false) },
      }, content)
    }

    function PixelSection(props) {
      const { api, remote, t } = props
      const [view, setView] = useState({ status: 'loading', error: null, section: null, creds: {} })
      // Page action in flight (login | verify | cancel | logout) and its wire failure.
      const [action, setAction] = useState(null)
      const [notice, setNotice] = useState(null)
      // The cancelChallengeAt this page's 返回 wrote (0: none); see `returning`.
      const [cancelSent, setCancelSent] = useState(0)
      // A sign-in submitted here and the auth status it started from:
      // { kind: 'login' | 'verify', state, message }. See the outcome effect.
      const [attempt, setAttempt] = useState(null)
      const [failures, setFailures] = useState(0)
      // A sign-in from this page just connected: the status dot pulses once.
      const [welcome, setWelcome] = useOneShot(PULSE_DELAY_MS + PULSE_MS)
      // Host reason for a refused 2FA code (the challenge ended in an error).
      const [otpFailure, setOtpFailure] = useState(null)
      const [reloading, setReloading] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [refreshError, setRefreshError] = useState(null)
      const refreshTimer = useRef(null)
      const autoRefreshed = useRef(false)
      const generationRef = useRef(0)

      const load = useCallback(async () => {
        const generation = ++generationRef.current
        try {
          const [settingsValue, credValue] = await Promise.all([
            api.settings.describe(),
            api.credentials.describe(Object.values(REFS)),
          ])
          if (generation !== generationRef.current) return
          const namespaces = settingsValue.namespaces || []
          const section = (namespaces.find((n) => n.ns === NS) || {}).value || null
          const creds = credValue || {}
          setView({ status: 'ready', error: null, section, creds })
        } catch (error) {
          if (generation !== generationRef.current) return
          setView({ status: 'error', error: msg(error), section: null, creds: {} })
        }
      }, [api])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        if (!remote || typeof remote.$on !== 'function') return undefined
        const reload = () => { void load() }
        const disposers = [
          remote.$on('settings/document-updated', () => reload()),
          remote.$on('credentials/record-updated', reload),
          remote.$on('credentials/reference-updated', reload),
          remote.$on('llm/adapters-updated', reload),
        ]
        return () => { for (const dispose of disposers) dispose() }
      }, [remote, load])

      // The host consumes a credential when its step ends, whatever the
      // outcome: a configured password means a sign-in is in flight, a
      // configured 2FA code a code being checked, and the refresh credential
      // is the session itself.
      const auth = authOf(view.section)
      const username = (view.section && view.section.username) || ''
      const configured = (ref) => !!(view.creds[ref] && view.creds[ref].configured)
      const session = configured(REFS.refresh)
      // The status this page's sign-in started from is not that sign-in's outcome.
      const stale = attempt !== null && auth.state === attempt.state && auth.message === attempt.message
      let phase = view.status
      if (view.status === 'ready') {
        if (auth.state === 'ok') phase = 'connected'
        else if (session) phase = auth.state === 'error' && !stale ? 'interrupted' : 'connecting'
        else if (auth.state === '2fa') phase = '2fa'
        else phase = 'login'
      }

      // Leaving the 2FA step on an error means the code was refused.
      const [seenPhase, setSeenPhase] = useState(phase)
      if (seenPhase !== phase) {
        setSeenPhase(phase)
        if (seenPhase === '2fa' && phase === 'login' && auth.state === 'error') setOtpFailure(auth.message)
      }

      // 返回 stays in progress — 返回, the code input and 验证并登录 locked —
      // while the page is still on the 2FA step and the host has not served
      // that request (it stamps the served value into auth.cancelChallengeAt).
      // Given up after HOST_WAIT_MS, as a VersionRow request is.
      const returning = phase === '2fa' && cancelSent > (Number(auth.cancelChallengeAt) || 0)
      useEffect(() => {
        if (!returning) return undefined
        // Poll as well, in case no settings/document-updated event reaches this page.
        const poll = setInterval(() => { void load() }, HOST_POLL_MS)
        const giveUp = setTimeout(() => setCancelSent(0), HOST_WAIT_MS)
        return () => { clearInterval(poll); clearTimeout(giveUp) }
      }, [returning, load])

      // Outcome of a sign-in this page submitted, read once the host has
      // consumed its credential. The host skips writing a status equal to
      // the current one, so a repeated refusal shows up only as the
      // credential going away under an unchanged error.
      const credPending = attempt !== null && configured(attempt.kind === 'login' ? REFS.password : REFS.otp)
      useEffect(() => {
        if (attempt === null || action !== null || credPending) return
        if (auth.state === 'ok') {
          setAttempt(null)
          setWelcome(true)
        } else if (session) {
          // Signed in, groups still loading: wait for 'ok', or a new error.
          if (auth.state === 'error' && !stale) setAttempt(null)
        } else if (auth.state === '2fa') {
          if (attempt.kind === 'login') setAttempt(null)
        } else if (auth.state === 'error') {
          setAttempt(null)
          setFailures((n) => n + 1)
        }
      }, [attempt, action, credPending, session, stale, auth.state])

      const run = useCallback(async (name, fn) => {
        setAction(name)
        setNotice(null)
        try {
          await fn()
        } catch (error) {
          // A failed wire call leaves no sign-in of this page in flight.
          setAttempt(null)
          setNotice(msg(error))
        } finally {
          setAction(null)
        }
      }, [])

      const login = (name, password) => run('login', async () => {
        setOtpFailure(null)
        setAttempt({ kind: 'login', state: auth.state, message: auth.message })
        await api.settings.mutate(NS, [{ op: 'set', path: ['username'], value: name }])
        await api.credentials.set(REFS.password, password)
        // Read the host's view before the action clears, so the button
        // never flashes idle between the two.
        await load()
      })

      const verify = (code) => run('verify', async () => {
        setAttempt({ kind: 'verify', state: auth.state, message: auth.message })
        await api.credentials.set(REFS.otp, code)
        await load()
      })

      // 返回 from the 2FA step. The challenge lives in the host's memory, so
      // only the host can end it: a newer cancelChallengeAt has it drop the
      // challenge, delete the 2FA code and password credentials and write
      // auth `none`, keeping the username. The page writes nothing else — a
      // status written here would be overwritten with 2fa while the challenge
      // stands — and stays 返回中 (`returning`) until that `none` lands.
      const cancelChallenge = () => run('cancel', async () => {
        const at = Date.now()
        await api.settings.mutate(NS, [{ op: 'set', path: ['cancelChallengeAt'], value: at }])
        setCancelSent(at)
      })

      // Sign-out order matters: raise signOutAt FIRST, because the host must
      // still hold the live access token and refresh cookie when it revokes the
      // site session. Clearing credentials first would tear the session down
      // locally and leave the site session alive.
      const logout = () => run('logout', async () => {
        await api.settings.mutate(NS, [
          { op: 'set', path: ['signOutAt'], value: Date.now() },
          { op: 'set', path: ['username'], value: '' },
          { op: 'set', path: ['auth'], value: { state: 'none', message: '', user: '', groups: [], models: -1 } },
        ])
        for (const ref of Object.values(REFS)) {
          await api.credentials.unset(ref)
        }
      })

      // Ask the host to refetch balance + groups (or, while disconnected, to
      // retry now). The host serves each newer refreshAt once; `refreshing`
      // clears when the auth status it writes lands, or after a timeout.
      const requestRefresh = useCallback(() => {
        setRefreshing(true)
        setRefreshError(null)
        clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => setRefreshing(false), REFRESH_SPIN_MS)
        api.settings.mutate(NS, [{ op: 'set', path: ['refreshAt'], value: Date.now() }])
          .catch((error) => { setRefreshing(false); setRefreshError(msg(error)) })
      }, [api])
      const authKey = JSON.stringify(auth)
      useEffect(() => { setRefreshing(false) }, [authKey])
      useEffect(() => () => clearTimeout(refreshTimer.current), [])

      // A balance older than 5 minutes refreshes once per signed-in session:
      // once when the page opens connected, and once more after signing out
      // and back in on the same page (losing the session re-arms it).
      const profile = auth.profile || {}
      const profileStamp = profile.updatedAt || 0
      useEffect(() => {
        if (view.status !== 'ready') return
        if (!session) {
          autoRefreshed.current = false
          return
        }
        if (autoRefreshed.current || auth.state !== 'ok') return
        autoRefreshed.current = true
        if (Date.now() - profileStamp > 5 * 60_000) requestRefresh()
      }, [view.status, session, auth.state, profileStamp, requestRefresh])

      const retryLoad = () => {
        setReloading(true)
        void load().finally(() => setReloading(false))
      }

      const signingIn = action === 'login' || configured(REFS.password) || (attempt !== null && attempt.kind === 'login')
      const verifying = action === 'verify' || configured(REFS.otp) || (attempt !== null && attempt.kind === 'verify')
      // Login card message: a failed page action, else what the host says
      // (hidden while a new sign-in runs).
      let message = notice ? { tone: 'err', text: notice } : null
      if (message === null && phase === 'login' && !signingIn && auth.message) {
        if (auth.state === 'error') {
          const text = otpFailure === auth.message ? fillText(t, 'err.otpFailed', { reason: auth.message }) : auth.message
          message = { tone: 'err', text }
        } else if (auth.state === 'none') {
          message = { tone: 'info', text: auth.message }
        }
      }
      const groupCount = typeof auth.groupCount === 'number' && auth.groupCount > 0
        ? auth.groupCount
        : (auth.groups || []).length
      const modelCount = typeof auth.models === 'number' ? auth.models : -1
      let mounted = ''
      if (groupCount > 0) {
        mounted = modelCount >= 0
          ? fillText(t, 'ok.mounted', { groups: groupCount, models: modelCount })
          : fillText(t, 'ok.mountedNoModels', { groups: groupCount })
      }

      const rowProps = { api, t, section: view.section, reload: load }
      const skeleton = phase === 'loading' || phase === 'connecting'
      const blocks = []
      // Each block fades in on mount, 40 ms after the one above it.
      const block = (key, el) => blocks.push(h('div', { key, className: 'pxa-enter', style: { '--pxa-i': blocks.length } }, el))
      const bar = (width, height) => h('span', { className: 'pxa-skel', style: { width, height } })

      if (skeleton) {
        block('skeleton-identity', h('div', { className: 'pxa-card pxa-identity', 'aria-hidden': true },
          h('div', { className: 'pxa-who' },
            h('span', { className: 'pxa-skel circle' }),
            h('div', { className: 'pxa-skel-lines' }, bar(96, 12), bar(160, 10)))))
        block('skeleton-balance', h('div', { className: 'pxa-card pxa-balance', 'aria-hidden': true },
          h('div', { className: 'pxa-line' }, bar(120, 14)),
          h('div', { className: 'pxa-divider' }),
          h('div', { className: 'pxa-line' }, bar(220, 10))))
      } else if (phase === 'error') {
        block('load-error', h(NoticeCard, {
          tone: 'err',
          text: fillText(t, 'load.failed', { reason: view.error }),
          action: t('action.retry'),
          busy: reloading,
          onAction: retryLoad,
        }))
      } else if (phase === 'connected' || phase === 'interrupted') {
        const connected = phase === 'connected'
        block('identity', h(IdentityCard, {
          t,
          name: profile.name || auth.user || username,
          detail: [profile.id ? 'ID ' + profile.id : '', profile.group].filter(Boolean).join(' · '),
          connected,
          pulse: connected && welcome,
          onPulseEnd: () => setWelcome(false),
        }))
        if (connected) {
          block('balance', h(BalanceCard, { t, profile, refreshing, error: refreshError, onRefresh: requestRefresh }))
        } else {
          block('retry', h(NoticeCard, {
            tone: refreshError ? 'err' : 'warn',
            text: refreshError || auth.message,
            action: t('action.retryNow'),
            busy: refreshing,
            onAction: requestRefresh,
          }))
        }
        block('settings', h('div', { className: 'pxa-card pxa-rows' },
          h(ContextRow, rowProps), h(ReplayRow, rowProps), h(VersionRow, rowProps)))
        block('footer', h(AccountFooter, { t, mounted, busy: action === 'logout', error: notice, onSignOut: logout }))
      } else {
        block('login', h(LoginCard, {
          t,
          step: phase === '2fa' ? 'otp' : 'password',
          initialUsername: username,
          user: auth.user || username,
          message,
          signingIn,
          verifying,
          cancelling: action === 'cancel' || returning,
          failures,
          onLogin: login,
          onVerify: verify,
          onBack: cancelChallenge,
        }))
        block('version', h('div', { className: 'pxa-card pxa-rows' }, h(VersionRow, rowProps)))
      }

      return h('div', { className: 'pxa-section', 'aria-busy': skeleton },
        skeleton ? h('span', { className: 'pxa-sr', role: 'status' }, t('status.loading')) : null,
        blocks)
    }

    // ---------------------------------------------------------------------
    // Two-column model picker (groups left with billing ratio, models right).
    // ---------------------------------------------------------------------

    const RATIO_MARK = ' ×'
    // index.js formatRatio writes the auto group's ratio as this word.
    const RATIO_AUTO = '自动'
    const MS_STYLE_ID = PLUGIN_ID + '/model-split.css'

    // Host route names end in the ratio, `名称 ×0.5` or `名称 ×自动`, when the
    // site gives one (index.js formatRatio), and are the bare name otherwise.
    // A room name may itself contain ` ×`, so split at the last mark and only
    // when a ratio follows it.
    function splitRatio(name) {
      const at = name.lastIndexOf(RATIO_MARK)
      const ratio = at > 0 ? name.slice(at + RATIO_MARK.length) : ''
      if (ratio !== RATIO_AUTO && !/^\d+(?:\.\d+)?$/.test(ratio)) return { name, ratio: '' }
      return { name: name.slice(0, at), ratio }
    }

    function orderProviders(groups) {
      const rank = (g) => (g.id === 'deepseek-account' ? 0 : g.id === 'deepseek-official' ? 1 : 2)
      return groups.slice().sort((a, b) => rank(a) - rank(b))
    }

    // Case-insensitive ordered-subsequence match, prefix hits first.
    function matchModels(models, query) {
      const q = query.trim().toLowerCase()
      if (!q) return models
      const scored = []
      models.forEach((m, i) => {
        const name = String(m.name || m.id).toLowerCase()
        let j = 0
        for (let k = 0; k < name.length && j < q.length; k++) if (name[k] === q[j]) j++
        if (j < q.length) return
        scored.push({ m, i, s: name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2 })
      })
      scored.sort((a, b) => a.s - b.s || a.i - b.i)
      return scored.map((x) => x.m)
    }

    function ratioTone(ratio) {
      const n = Number(ratio)
      if (!Number.isFinite(n)) return 'auto'
      if (n < 1) return 'low'
      if (n > 1) return 'high'
      return 'base'
    }

    function installSplitStyles() {
      if (document.getElementById(MS_STYLE_ID)) return () => {}
      const style = document.createElement('style')
      style.id = MS_STYLE_ID
      style.textContent = `
        .pxm-root { position: relative; min-width: 0; }
        .pxm-trigger {
          display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 360px;
          height: 28px; padding: 0 4px 0 8px; border: none; outline: none;
          border-radius: var(--dsw-radius-sm, 6px); background: transparent;
          color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px;
          line-height: 20px; cursor: pointer;
        }
        .pxm-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .pxm-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary); }
        .pxm-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
        .pxm-trigger-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pxm-trigger-effort { flex-shrink: 1000; min-width: 0; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; color: var(--dsw-alias-label-caption); }
        .pxm-chevron { flex: 0 0 auto; width: 12px; height: 12px; color: var(--dsw-alias-label-caption);
          transition: transform 120ms ease; }
        .pxm-chevron.open { transform: rotate(180deg); }
        .pxm-busy { flex: 0 0 auto; display: inline-flex; color: var(--dsw-alias-label-caption); }

        .pxm-menu {
          position: fixed; z-index: 1100; box-sizing: border-box;
          display: flex; flex-direction: column;
          width: min(640px, calc(100vw - 24px)); height: min(440px, calc(100dvh - 96px));
          padding: 6px; border-radius: var(--dsw-radius-xl, 12px);
          background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-menu-bg, #fff));
          color: var(--dsw-alias-label-primary);
          --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
          box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.14));
          border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
          --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
          --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
        }
        .pxm-body { flex: 1; min-height: 0; display: flex; gap: 6px; }
        .pxm-col { min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }
        .pxm-left { flex: 0 0 216px; padding-right: 6px;
          border-right: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); }
        .pxm-right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .pxm-heading { padding: 6px 8px 4px; font-size: 11px; line-height: 16px; font-weight: 600;
          color: var(--dsw-alias-label-tertiary); }
        .pxm-search { box-sizing: border-box; width: 100%; height: 30px; margin: 0 0 4px;
          padding: 0 8px; border: none; outline: none; border-radius: var(--dsw-radius-md, 8px);
          background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08));
          color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
        .pxm-search::placeholder { color: var(--dsw-alias-label-caption); }
        .pxm-row {
          box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%;
          min-height: 32px; padding: 5px 8px; border: none; outline: none;
          border-radius: var(--dsw-radius-md, 8px); background: transparent; color: inherit;
          font: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer;
        }
        .pxm-row:hover:not(:disabled), .pxm-row.hl { background: var(--dsw-alias-interactive-bg-hover); }
        .pxm-row.active { background: var(--dsw-alias-interactive-bg-hover);
          font-weight: 600; }
        .pxm-row:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
        .pxm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pxm-gtext { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .pxm-gid { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;
          line-height: 15px; font-weight: 400; color: var(--dsw-alias-label-tertiary);
          font-family: var(--dsw-font-mono, ui-monospace, monospace); }
        .pxm-ratio { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 17px;
          font-weight: 500; font-variant-numeric: tabular-nums;
          background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1));
          color: var(--dsw-alias-label-secondary); }
        .pxm-ratio.low { color: var(--dsw-alias-state-success-primary, #2ea043);
          background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea043) 12%, transparent); }
        .pxm-ratio.high { color: var(--dsw-alias-state-warn-label, #b07000);
          background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b07000) 12%, transparent); }
        .pxm-dot { flex: none; width: 6px; height: 6px; border-radius: 50%;
          background: var(--dsw-alias-state-business-primary, #4d6bfe); }
        .pxm-check { flex: none; width: 14px; height: 14px; color: var(--dsw-alias-label-primary); }
        .pxm-note { padding: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
        .pxm-warn { margin: 0 0 4px; padding: 6px 8px; border-radius: var(--dsw-radius-md, 8px);
          font-size: 11px; line-height: 16px; display: flex; gap: 6px; justify-content: space-between;
          background: var(--dsw-alias-bg-module-platform, rgba(176,112,0,.08));
          color: var(--dsw-alias-state-warn-label, #b07000); }
        .pxm-warn button { border: none; background: transparent; color: inherit; font: inherit;
          font-weight: 600; cursor: pointer; padding: 0; }
        .pxm-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px;
          padding: 6px 4px 0; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
          font-size: 12px; color: var(--dsw-alias-label-tertiary); }
        .pxm-chip { height: 24px; padding: 0 10px; border-radius: 999px; font: inherit; font-size: 12px;
          cursor: pointer; color: var(--dsw-alias-label-secondary); background: transparent;
          border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25)); }
        .pxm-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .pxm-chip.on { color: var(--dsw-alias-label-primary); font-weight: 600;
          border-color: var(--dsw-alias-label-secondary); }
      `
      document.head.appendChild(style)
      return () => style.remove()
    }

    const ChevronIcon = (props) => h('svg', { className: props.className, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('polyline', { points: '6 9 12 15 18 9' }))
    const SmallCheck = () => h('svg', { className: 'pxm-check', viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('polyline', { points: '20 6 9 17 4 12' }))

    function SplitModelSelect(props) {
      // `tp` is the page's copy function, injected by apply below.
      const { locked, available, directory, load, select, tp: t } = props
      const useSyncExternalStore = React.useSyncExternalStore
      const state = useSyncExternalStore((fn) => directory.subscribe(fn), () => directory.getSnapshot())
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [activeGroup, setActiveGroup] = useState(null)
      const [hl, setHl] = useState(0)
      const [pos, setPos] = useState(null)
      const [error, setError] = useState(null)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const searchRef = useRef(null)
      const rowRefs = useRef([])
      const id = useId()

      const groupName = (g) => (g.id === 'deepseek-account' ? t('picker.account') : String(g.name || g.id))
      const ratioText = (ratio) => (ratio === RATIO_AUTO ? t('picker.ratio.auto') : ratio)
      const groups = React.useMemo(() => orderProviders(state.groups || []).map((g) => {
        const parts = splitRatio(groupName(g))
        // PIXEL routes are `pixel/<site group key>`; the key is the group ID.
        const key = String(g.id).startsWith('pixel/') ? String(g.id).slice(6) : ''
        return { id: g.id, key, models: g.models || [], name: parts.name, ratio: parts.ratio }
      }), [state.groups, t])

      const current = state.current
      const currentGroup = current ? groups.find((g) => g.id === current.provider) : undefined
      const currentModel = currentGroup ? currentGroup.models.find((m) => m.id === current.model) : undefined
      const reasoning = currentModel && currentModel.reasoning
      const effort = (current && current.reasoningEffort) || (reasoning && reasoning.defaultEffort)
      const effortName = reasoning
        ? ((reasoning.efforts || []).find((e) => e.id === effort) || {}).name || effort || t('picker.defaultEffort')
        : state.retainedEffort
      const busy = state.pending != null

      // While searching, the left column narrows to groups with hits.
      const visibleGroups = React.useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return groups
        return groups.filter((g) => matchModels(g.models, query).length > 0
          || g.name.toLowerCase().includes(q) || g.key.toLowerCase().includes(q))
      }, [groups, query])
      const shownGroup = visibleGroups.find((g) => g.id === activeGroup) || visibleGroups[0]
      // A query that hit the group itself (name / ID) lists all its models.
      const groupHit = (g) => {
        const q = query.trim().toLowerCase()
        return !!q && (g.name.toLowerCase().includes(q) || g.key.toLowerCase().includes(q))
      }
      const shownModels = shownGroup
        ? (groupHit(shownGroup) && matchModels(shownGroup.models, query).length === 0
          ? shownGroup.models
          : matchModels(shownGroup.models, query))
        : []

      const place = useCallback(() => {
        const r = triggerRef.current && triggerRef.current.getBoundingClientRect()
        if (!r) return
        const width = Math.min(640, window.innerWidth - 24)
        const left = Math.max(12, Math.min(r.right - width, window.innerWidth - 12 - width))
        setPos({ left, bottom: Math.max(12, window.innerHeight - r.top + 8) })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        place()
        const onDown = (e) => {
          if (rootRef.current && rootRef.current.contains(e.target)) return
          if (menuRef.current && menuRef.current.contains(e.target)) return
          setOpen(false)
        }
        window.addEventListener('resize', place)
        document.addEventListener('mousedown', onDown)
        return () => {
          window.removeEventListener('resize', place)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open, place])

      useEffect(() => {
        if (open && searchRef.current) searchRef.current.focus()
      }, [open])

      useEffect(() => {
        const el = rowRefs.current[hl]
        if (open && el) el.scrollIntoView({ block: 'nearest' })
      }, [open, hl, shownGroup && shownGroup.id])

      if (!available) return null

      const show = () => {
        setQuery('')
        setError(null)
        setActiveGroup(current ? current.provider : null)
        const g = currentGroup
        const idx = g && current ? Math.max(0, g.models.findIndex((m) => m.id === current.model)) : 0
        setHl(idx)
        setOpen(true)
        load()
      }
      const close = (focus) => {
        setOpen(false)
        if (focus) queueMicrotask(() => triggerRef.current && triggerRef.current.focus())
      }

      const submit = (selection) => {
        setError(null)
        void select(selection).then((res) => {
          if (res === undefined) return
          if (res.ok) close(true)
          else setError(res.error && res.error.code === 'session/writer-held'
            ? t('picker.writerHeld')
            : fillText(t, 'picker.switchFailed', { reason: (res.error && res.error.message) || t('picker.unknownError') }))
        }, (e) => setError(fillText(t, 'picker.switchFailed', { reason: msg(e) })))
      }
      const chooseModel = (group, model) => {
        if (current && current.provider === group.id && current.model === model.id) {
          close(true)
          return
        }
        const def = model.reasoning && model.reasoning.defaultEffort
        submit({ provider: group.id, model: model.id, ...(def === undefined ? {} : { reasoningEffort: def }) })
      }
      // Picking the effort already in use closes the menu, as picking the
      // current model does.
      const chooseEffort = (effortId) => {
        if (!current) return
        if (effortId === effort) {
          close(true)
          return
        }
        submit({ provider: current.provider, model: current.model, ...(effortId === undefined ? {} : { reasoningEffort: effortId }) })
      }

      // On the root only: React bubbles events from the portalled menu up the
      // component tree to the root, so a second handler on the menu ran every
      // key twice (Enter chose the model twice).
      const onKeyDown = (e) => {
        if (e.nativeEvent && e.nativeEvent.isComposing) return
        if (!open) return
        if (e.key === 'Escape') { e.preventDefault(); close(true); return }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (shownModels.length === 0) return
          const d = e.key === 'ArrowDown' ? 1 : -1
          setHl((hl + d + shownModels.length) % shownModels.length)
          return
        }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey) {
          e.preventDefault()
          const i = visibleGroups.findIndex((g) => g === shownGroup)
          const d = e.key === 'ArrowRight' ? 1 : -1
          const next = visibleGroups[(i + d + visibleGroups.length) % visibleGroups.length]
          if (next) { setActiveGroup(next.id); setHl(0) }
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          const m = shownModels[Math.min(hl, shownModels.length - 1)]
          if (m && !busy) chooseModel(shownGroup, m)
        }
      }

      const loading = state.status === 'loading'
      const label = currentModel
        ? (currentModel.name || currentModel.id)
        : loading ? t('picker.loading') : t('picker.choose')
      const triggerTitle = currentModel
        ? `${currentGroup.name}${currentGroup.ratio ? RATIO_MARK + ratioText(currentGroup.ratio) : ''} · ${label}${effortName ? ' · ' + effortName : ''}`
        : label
      // The search box points screen readers at the highlighted row. A row's
      // id follows its model (group, and place in the group's full list), so
      // moving the highlight, switching group or narrowing the search each
      // names a new row, which they announce.
      const listId = id + '-models'
      const groupIndex = groups.indexOf(shownGroup)
      const optionId = (m) => id + '-model-' + groupIndex + '-' + shownGroup.models.indexOf(m)
      const activeModel = shownModels[hl]

      rowRefs.current = []
      const menu = open && pos ? createPortal(h('div', {
        ref: menuRef,
        className: 'pxm-menu',
        role: 'dialog',
        'aria-label': t('picker.title'),
        style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
      },
        h('input', {
          ref: searchRef,
          className: 'pxm-search',
          role: 'searchbox',
          'aria-label': t('picker.search'),
          'aria-controls': listId,
          'aria-activedescendant': activeModel ? optionId(activeModel) : undefined,
          placeholder: t('picker.search'),
          value: query,
          onChange: (e) => { setQuery(e.target.value); setHl(0) },
        }),
        error ? h('div', { className: 'pxm-warn' }, h('span', null, error)) : null,
        state.error ? h('div', { className: 'pxm-warn' },
          h('span', null, fillText(t, 'picker.catalogFailed', { reason: state.error })),
          h('button', { type: 'button', onClick: load }, t('action.retry'))) : null,
        (state.failures || []).map((f) => h('div', { key: 'f:' + f.id, className: 'pxm-warn' },
          h('span', null, fillText(t, 'picker.groupFailed', { group: splitRatio(groupName(f)).name, reason: f.message })),
          h('button', { type: 'button', onClick: load }, t('action.retry')))),
        h('div', { className: 'pxm-body' },
          h('div', { className: 'pxm-col pxm-left', role: 'listbox', 'aria-label': t('picker.groups') },
            h('div', { className: 'pxm-heading' }, t('picker.groups')),
            visibleGroups.length === 0
              ? h('div', { className: 'pxm-note' }, loading ? t('picker.refreshing') : (groups.length ? t('picker.noMatch') : t('picker.empty')))
              : visibleGroups.map((g) => h('button', {
                key: g.id,
                type: 'button',
                role: 'option',
                'aria-selected': g === shownGroup,
                className: 'pxm-row' + (g === shownGroup ? ' active' : ''),
                title: [g.name,
                  g.key ? fillText(t, 'picker.tip.id', { id: g.key }) : '',
                  g.ratio ? fillText(t, 'picker.tip.ratio', { ratio: ratioText(g.ratio) }) : ''].filter(Boolean).join('\n'),
                onClick: () => { setActiveGroup(g.id); setHl(0); searchRef.current && searchRef.current.focus() },
              },
                h('span', { className: 'pxm-gtext' },
                  h('span', { className: 'pxm-name' }, g.name),
                  g.key && g.key !== g.name ? h('span', { className: 'pxm-gid' }, fillText(t, 'picker.groupId', { id: g.key })) : null),
                current && current.provider === g.id ? h('span', { className: 'pxm-dot', title: t('picker.currentGroup') }) : null,
                g.ratio ? h('span', { className: 'pxm-ratio ' + ratioTone(g.ratio) }, '×' + ratioText(g.ratio)) : null,
              ))),
          h('div', { id: listId, className: 'pxm-col pxm-right', role: 'listbox', 'aria-label': t('picker.models') },
            h('div', { className: 'pxm-heading' },
              shownGroup
                ? [shownGroup.name,
                  shownGroup.key && shownGroup.key !== shownGroup.name ? fillText(t, 'picker.head.id', { id: shownGroup.key }) : '',
                  shownGroup.ratio ? fillText(t, 'picker.head.ratio', { ratio: ratioText(shownGroup.ratio) }) : ''].filter(Boolean).join(' · ')
                : t('picker.models')),
            loading && shownModels.length === 0 ? h('div', { className: 'pxm-note' }, t('picker.refreshing')) : null,
            !loading && shownGroup && shownModels.length === 0 ? h('div', { className: 'pxm-note' }, t('picker.groupEmpty')) : null,
            shownModels.map((m, i) => {
              const selected = current && shownGroup && current.provider === shownGroup.id && current.model === m.id
              const pending = state.pending && shownGroup && state.pending.provider === shownGroup.id && state.pending.model === m.id
              return h('button', {
                key: m.id,
                id: optionId(m),
                ref: (el) => { rowRefs.current[i] = el },
                type: 'button',
                role: 'option',
                'aria-selected': !!selected,
                disabled: busy,
                title: m.description ? `${m.name || m.id}\n${m.description}` : (m.name || m.id),
                className: 'pxm-row' + (i === hl ? ' hl' : ''),
                onMouseMove: () => { if (hl !== i) setHl(i) },
                onClick: () => chooseModel(shownGroup, m),
              },
                h('span', { className: 'pxm-name' }, m.name || m.id),
                pending ? h('span', { className: 'pxm-note', style: { padding: 0 } }, t('picker.switching')) : selected ? h(SmallCheck) : null,
              )
            }),
          ),
        ),
        reasoning && (reasoning.efforts || []).length > 0
          ? h('div', { className: 'pxm-foot' },
            h('span', null, t('picker.effort')),
            reasoning.defaultEffort === undefined
              ? h('button', { type: 'button', disabled: busy, className: 'pxm-chip' + (effort === undefined ? ' on' : ''), onClick: () => chooseEffort(undefined) }, t('picker.defaultEffort'))
              : null,
            reasoning.efforts.map((lv) => h('button', {
              key: lv.id, type: 'button', disabled: busy,
              className: 'pxm-chip' + (effort === lv.id ? ' on' : ''),
              onClick: () => chooseEffort(lv.id),
            }, lv.name || lv.id)))
          : null,
      ), document.body) : null

      return h('div', { ref: rootRef, className: 'pxm-root', onKeyDown },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'pxm-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-busy': busy,
          title: triggerTitle,
          disabled: locked,
          onClick: () => (open ? close(true) : show()),
        },
          h('span', { className: 'pxm-trigger-label' }, label),
          effortName && currentModel ? h('span', { className: 'pxm-trigger-effort' }, effortName) : null,
          // A switch in flight spins in place of the chevron, open menu or not.
          busy
            ? h('span', { className: 'pxm-busy' }, h(Spinner, { size: 12 }))
            : h(ChevronIcon, { className: 'pxm-chevron' + (open ? ' open' : '') }),
        ),
        menu,
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pixel-api: copy dictionaries')
      ctx.effect(installStyles, 'pixel-api: styles')
      ctx.effect(installSplitStyles, 'pixel-api: model picker styles')
      const t = ctx.locale.bind(NS)
      const injected = () => {
        const call = async (fn) => {
          const res = await fn()
          if (!res || res.ok !== true) {
            throw new Error((res && res.error && res.error.message) || 'wire call failed')
          }
          return res.value
        }
        const api = {
          settings: {
            describe: () => call(() => ctx.remote.settings.describe()),
            mutate: (ns, ops) => call(() => ctx.remote.settings.mutate(ns, ops, undefined)),
          },
          credentials: {
            describe: (refs) => call(() => ctx.remote.credentials.describe(refs)),
            set: (ref, value) => call(() => ctx.remote.credentials.set(ref, value)),
            unset: (ref) => call(() => ctx.remote.credentials.unset(ref)),
          },
        }
        return { api, remote: ctx.remote, t }
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'pixel-api',
        order: 90,
        label: () => 'PIXEL API',
        inject: injected,
      }, PixelSection))

      // Two-column model picker. A dynamically registered entry in the
      // single `conversation.input.model` seat shadows the shipped picker;
      // if this component ever crashes the renderer retires it and the
      // shipped picker takes the seat back. Data and selection go through
      // the same per-session ModelDirectory the shipped picker and /model use.
      ctx.inject(['modelDirectories', 'sessions'], (scope) => {
        scope.slots.inject('conversation.input.model', () => scope.slots.register({
          name: 'conversation.input.model',
          // Single slot: the LOWEST priority renders, and two entries at the
          // same priority are rejected. Shipped seat uses the default 0.
          priority: -20,
          inject: (sessionId) => {
            const available = scope.sessions.subagentAddress(sessionId) === undefined
            const directory = scope.modelDirectories.directoryFor(sessionId)
            return {
              available,
              directory: directory.store,
              load: () => { if (available) directory.load().catch(() => {}) },
              select: (selection) => available ? directory.select(selection) : Promise.resolve(undefined),
              tp: t,
            }
          },
        }, SplitModelSelect))
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm']
    module.exports = exports
    return module.exports
  },
})

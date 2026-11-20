// PIXEL API — browser half. Registers the 设置 → PIXEL API page: account
// login (username + password → settings/credentials wire), one-shot TOTP for
// 2FA challenges, a session status card, the context window settings, and
// logout. No secret is ever held or rendered here — the host half owns
// tokens, refresh, and chat traffic.

window.__ModuleLoader__.load({
  id: 'dsh-pixel-api',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
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
    const STYLE_ID = PLUGIN_ID + '/pixel-api.css'
    const REFS = {
      password: 'PIXEL_API_PASSWORD',
      refresh: 'PIXEL_API_REFRESH',
      otp: 'PIXEL_API_2FA',
    }

    const zh = {
      'title': 'PIXEL API',
      'subtitle': '使用主站账号登录，对话按主站钱包余额计费，无需 API Key。',
      'field.username': '用户名',
      'field.username.placeholder': '请输入主站用户名',
      'field.password': '密码',
      'field.password.placeholder': '请输入主站密码',
      'field.otp': '两步验证码（TOTP）',
      'field.otp.placeholder': '请输入 6 位动态验证码',
      'action.login': '登录',
      'action.loggingIn': '登录中…',
      'action.verify': '验证并登录',
      'action.verifying': '验证中…',
      'action.logout': '退出登录',
      'action.refresh': '刷新状态',
      'action.showPassword': '显示密码',
      'action.hidePassword': '隐藏密码',
      'action.cancel': '取消',
      'status.loading': '正在检查会话状态…',
      'status.pending': '正在登录主站…',
      'status.ok': '已连接',
      'status.2fa': '需要两步验证',
      'status.error': '登录遇到问题',
      'status.none': '未登录',
      'card.loginTitle': '主站账号登录',
      'card.otpTitle': '两步验证挑战（2FA）',
      'card.statusTitle': '当前连接状态',
      'ok.balance': '账户余额',
      'ok.used': '已用 {used}',
      'ok.requests': '{count} 次请求',
      'ok.userGroup': '用户分组 {group}',
      'ok.mounted': '已接入 {groups} 个分组 · {models} 个模型，可在输入框的模型选择器中使用',
      'ok.mountedNoModels': '已接入 {groups} 个分组，可在输入框的模型选择器中使用',
      'ok.updated': '更新于 {time}',
      'ok.updating': '正在更新…',
      'ok.unknown': '—',
      'action.topup': '充值',
      'action.openSite': '打开主站',
      'hint.session': '密码只用于本次登录，登录成功后会立即从本机删除；本机只保留主站签发的登录会话（相当于浏览器里的登录状态）。',
      'hint.expired': '登录会话（约 30 天）会自动续期；会话失效后需要重新输入一次密码。',
      'err.required': '请输入主站用户名和密码。',
      'err.requiredOtp': '请输入两步验证码。',
      'site': '服务地址',
      'walletMode': '钱包直接扣费（无 API Key）',
      'ctx.title': '上下文窗口',
      'ctx.desc': 'Harness 按这个窗口决定何时自动压缩历史，以及会话中途能否切换到 PIXEL 模型。主站不提供各模型的实际上限，默认按 272K token 计算；与实际不符时在这里调整。',
      'ctx.default': '默认窗口（token）',
      'ctx.overrides': '按模型单独设置',
      'ctx.overrides.placeholder': '每行一条：模型 ID = token 数，以 * 结尾按前缀匹配\ngemini-* = 1048576\nclaude-opus-5-5 = 1000000',
      'ctx.hint': '精确的模型 ID 优先于前缀，较长的前缀优先于较短的，不区分大小写；数字可写 272k、1m。修改从下一次请求起生效。',
      'ctx.summary': '当前默认 {window} token · {rules} 条单独设置',
      'ctx.save': '保存',
      'ctx.saving': '保存中…',
      'ctx.reset': '恢复默认',
      'ctx.saved': '已保存，下一次请求起生效。',
      'replay.title': 'GPT 加密推理回传',
      'replay.desc': '开启后，GPT 模型在工具调用的每一步会带回上一步的加密推理，推理更连贯。主站只认产生它的上游账号：同一分组有多个渠道、而主站没有对 /pg/chat/completions 开渠道亲和时，请求换到别的账号会失败，这个会话后面的请求也会跟着失败，关掉本开关即可恢复。确认分组只有一个渠道或主站已配置亲和后再开。',
      'replay.on': '已开启',
      'replay.off': '已关闭',
      'err.ctx.default': '默认窗口必须是大于 65536 的整数（Harness 压缩默认预留 65536 token）。',
      'err.ctx.line': '第 {line} 行格式不对：应为「模型 ID = token 数」，token 数须为大于 65536 的整数。',
      'err.ctx.star': '第 {line} 行：单独的 * 会覆盖所有模型，请直接修改默认窗口。',
      'upd.title': '插件更新',
      'upd.version': '当前版本 v{version}',
      'upd.idle': '点「检查更新」会从 GitHub 读取最新版本，平时不会联网检查。',
      'upd.checking': '正在检查更新…',
      'upd.latest': '已是最新版本（v{version}）。',
      'upd.available': '发现新版本 v{version}。',
      'upd.availableHint': '更新时插件管理会先移除当前版本再安装新版本，期间 PIXEL 模型和这个页面会暂时消失；安装失败会自动恢复当前版本。',
      'upd.unsupported': '最新版本是 v{version}，但这份插件不能在这里一键更新：{reason}。',
      'upd.error': '检查更新失败：{reason}',
      'upd.updating': '正在更新到 v{version}…完成后这个页面会自动恢复；如果一直没有恢复，请重启 DeepSeek Harness。',
      'upd.updated': '已更新到 v{version}。',
      'upd.restart': 'v{version} 已安装，重启 DeepSeek Harness 后生效。',
      'upd.failed': '更新失败：{reason}',
      'upd.checkedAt': '上次检查 {time}',
      'upd.check': '检查更新',
      'upd.apply': '更新到 v{version}',
      'upd.confirm': '确认更新',
      'upd.cancel': '取消',
    }

    const en = {
      'title': 'PIXEL API',
      'subtitle': 'Sign in with your main-site account; chats bill your site wallet, no API key needed.',
      'field.username': 'Username',
      'field.username.placeholder': 'Enter your main-site username',
      'field.password': 'Password',
      'field.password.placeholder': 'Enter your password',
      'field.otp': 'Two-factor Code (TOTP)',
      'field.otp.placeholder': 'Enter 6-digit TOTP code',
      'action.login': 'Sign in',
      'action.loggingIn': 'Signing in…',
      'action.verify': 'Verify & Sign in',
      'action.verifying': 'Verifying…',
      'action.logout': 'Sign out',
      'action.refresh': 'Refresh',
      'action.showPassword': 'Show password',
      'action.hidePassword': 'Hide password',
      'action.cancel': 'Cancel',
      'status.loading': 'Checking session status…',
      'status.pending': 'Signing in…',
      'status.ok': 'Connected',
      'status.2fa': 'Two-factor required',
      'status.error': 'Sign in error',
      'status.none': 'Not signed in',
      'card.loginTitle': 'Sign In with Main Site Account',
      'card.otpTitle': 'Two-Factor Challenge (2FA)',
      'card.statusTitle': 'Connection Status',
      'ok.balance': 'Balance',
      'ok.used': 'Used {used}',
      'ok.requests': '{count} requests',
      'ok.userGroup': 'Group {group}',
      'ok.mounted': '{groups} groups · {models} models available in the composer model picker',
      'ok.mountedNoModels': '{groups} groups available in the composer model picker',
      'ok.updated': 'Updated {time}',
      'ok.updating': 'Updating…',
      'ok.unknown': '—',
      'action.topup': 'Top up',
      'action.openSite': 'Open site',
      'hint.session': 'The password is used for this one sign-in and deleted from this machine right after; only the site-issued session (like a browser login) is kept.',
      'hint.expired': 'The sign-in session (about 30 days) renews automatically; enter your password again once it lapses.',
      'err.required': 'Username and password are required.',
      'err.requiredOtp': 'Enter the two-factor code.',
      'site': 'Server',
      'walletMode': 'Direct Wallet Billing (No API Key)',
      'ctx.title': 'Context window',
      'ctx.desc': 'The Harness uses this window to decide when to compact history and whether a session can switch to a PIXEL model mid-conversation. The site does not publish per-model limits, so 272K tokens is assumed; adjust it here when a model differs.',
      'ctx.default': 'Default window (tokens)',
      'ctx.overrides': 'Per-model windows',
      'ctx.overrides.placeholder': 'One per line: model ID = tokens; end with * to match a prefix\ngemini-* = 1048576\nclaude-opus-5-5 = 1000000',
      'ctx.hint': 'An exact model ID beats a prefix and a longer prefix beats a shorter one, ignoring case; numbers may be written as 272k or 1m. Changes apply from the next request.',
      'ctx.summary': 'Default {window} tokens · {rules} per-model rules',
      'ctx.save': 'Save',
      'ctx.saving': 'Saving…',
      'ctx.reset': 'Restore defaults',
      'ctx.saved': 'Saved; applies from the next request.',
      'replay.title': 'GPT encrypted-reasoning passback',
      'replay.desc': "When on, GPT models carry the previous step's encrypted reasoning into each tool-calling step, for more coherent reasoning. The site accepts it only from the upstream account that produced it: if a group has several channels and the site has no channel affinity for /pg/chat/completions, a request that moves to another account fails and the rest of this session's requests fail with it — turn this switch off to recover. Turn it on only after confirming the group has a single channel, or that the site has affinity configured.",
      'replay.on': 'On',
      'replay.off': 'Off',
      'err.ctx.default': 'The default window must be an integer above 65536 (Harness compaction reserves 65536 tokens by default).',
      'err.ctx.line': 'Line {line} is malformed: use "model ID = tokens" with an integer above 65536.',
      'err.ctx.star': 'Line {line}: a bare * would cover every model; change the default window instead.',
      'upd.title': 'Plugin updates',
      'upd.version': 'Version v{version}',
      'upd.idle': 'Check for updates reads the newest version from GitHub; nothing is checked in the background.',
      'upd.checking': 'Checking for updates…',
      'upd.latest': 'You have the newest version (v{version}).',
      'upd.available': 'Version v{version} is available.',
      'upd.availableHint': 'The plugin manager removes this version, then installs the new one; PIXEL models and this page disappear meanwhile. A failed installation restores this version.',
      'upd.unsupported': 'The newest version is v{version}, but this copy cannot be updated here: {reason}.',
      'upd.error': 'Checking for updates failed: {reason}',
      'upd.updating': 'Updating to v{version}… This page comes back when it finishes; restart DeepSeek Harness if it does not.',
      'upd.updated': 'Updated to v{version}.',
      'upd.restart': 'v{version} is installed and takes effect after restarting DeepSeek Harness.',
      'upd.failed': 'The update failed: {reason}',
      'upd.checkedAt': 'Last checked {time}',
      'upd.check': 'Check for updates',
      'upd.apply': 'Update to v{version}',
      'upd.confirm': 'Confirm update',
      'upd.cancel': 'Cancel',
    }

    // Inline SVG Icons
    const EyeIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
      h('circle', { cx: 12, cy: 12, r: 3 })
    )

    const EyeOffIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' }),
      h('line', { x1: 1, y1: 1, x2: 23, y2: 23 })
    )

    const ShieldIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' })
    )

    const GlobeIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('circle', { cx: 12, cy: 12, r: 10 }),
      h('line', { x1: 2, y1: 12, x2: 22, y2: 12 }),
      h('path', { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' })
    )

    const LockIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('rect', { x: 3, y: 11, width: 18, height: 11, rx: 2, ry: 2 }),
      h('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' })
    )

    const KeyIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M21 2l-2 2m-1.5 1.5L14 9l-3-3-4 4 3 3-5 5v3h3l5-5 3 3 4-4-3-3 3.5-3.5z' })
    )

    const CheckIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('polyline', { points: '20 6 9 17 4 12' })
    )

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .pxa-section {
          display: flex;
          flex-direction: column;
          gap: 16px;
          max-width: 640px;
          color: var(--dsw-alias-label-primary, #18191b);
          font-family: inherit;
        }

        .pxa-header {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .pxa-header-top {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .pxa-title {
          font-size: 18px;
          font-weight: 600;
          line-height: 26px;
          color: var(--dsw-alias-label-primary, #18191b);
          margin: 0;
        }

        .pxa-site-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 2px 8px;
          border-radius: var(--dsw-radius-sm, 6px);
          background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08));
          border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.2));
          color: var(--dsw-alias-label-secondary, #585a60);
          font-size: 12px;
          line-height: 18px;
          font-family: var(--dsw-font-mono, monospace);
        }

        .pxa-desc {
          font-size: 13px;
          line-height: 20px;
          color: var(--dsw-alias-label-secondary, #585a60);
          margin: 0;
        }

        .pxa-card {
          border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, rgba(0,0,0,0.1)));
          background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, #ffffff));
          border-radius: var(--dsw-radius-xl, 14px);
          padding: 18px 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }

        .pxa-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding-bottom: 12px;
          border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15));
        }

        .pxa-card-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .pxa-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .pxa-label {
          font-size: 13px;
          font-weight: 500;
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-input-wrap {
          position: relative;
          display: flex;
          align-items: center;
          width: 100%;
        }

        .pxa-input {
          box-sizing: border-box;
          width: 100%;
          height: 38px;
          padding: 0 12px;
          border-radius: var(--dsw-radius-md, 8px);
          border: 1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25));
          background: var(--dsw-alias-bg-layer-1, #ffffff);
          color: var(--dsw-alias-label-primary, #18191b);
          font-size: 14px;
          line-height: 22px;
          font-family: inherit;
          outline: none;
          transition: border-color .15s ease, box-shadow .15s ease;
        }

        .pxa-input.has-toggle {
          padding-right: 38px;
        }

        .pxa-input:focus {
          border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 18%, transparent);
        }

        .pxa-input::placeholder {
          color: var(--dsw-alias-label-dimmed, #9ca3af);
          opacity: 1;
        }

        .pxa-input:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .pxa-toggle-btn {
          position: absolute;
          right: 4px;
          height: 30px;
          width: 30px;
          border-radius: var(--dsw-radius-sm, 6px);
          border: none;
          background: transparent;
          color: var(--dsw-alias-label-tertiary, #81858c);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 0;
          transition: color .15s ease, background-color .15s ease;
        }

        .pxa-toggle-btn:hover {
          color: var(--dsw-alias-label-primary, #18191b);
          background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08));
        }

        .pxa-actions {
          display: flex;
          gap: 10px;
          align-items: center;
          padding-top: 4px;
        }

        .pxa-btn {
          box-sizing: border-box;
          height: 36px;
          padding: 0 18px;
          border-radius: var(--dsw-radius-md, 8px);
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all .15s ease;
          border: 1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25));
          background: var(--dsw-alias-bg-layer-1, #ffffff);
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-btn:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08));
        }

        .pxa-btn.primary {
          border: none;
          background: var(--dsw-alias-button-primary-fill, #4d6bfe);
          color: var(--dsw-alias-label-primary-foreground, #ffffff);
        }

        .pxa-btn.primary:hover:not(:disabled) {
          background: var(--dsw-alias-button-primary-hover, #3b5bf5);
        }

        .pxa-btn.danger {
          color: var(--dsw-alias-state-error-primary, #d54941);
          border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 30%, transparent);
        }

        .pxa-btn.danger:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover-danger, rgba(213,73,65,0.08));
        }

        .pxa-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .pxa-banner {
          padding: 10px 14px;
          border-radius: var(--dsw-radius-md, 8px);
          font-size: 13px;
          line-height: 20px;
          display: flex;
          align-items: flex-start;
          gap: 8px;
        }

        .pxa-banner.err {
          background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 10%, transparent);
          border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 30%, transparent);
          color: var(--dsw-alias-state-error-primary, #d54941);
        }

        .pxa-banner.info {
          background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent);
          border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 25%, transparent);
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-banner.warn {
          background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b07000) 10%, transparent);
          border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-label, #b07000) 28%, transparent);
          color: var(--dsw-alias-state-warn-label, #b07000);
        }

        .pxa-security-hint {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary, #81858c);
          margin-top: 4px;
        }

        .pxa-security-hint svg {
          flex-shrink: 0;
          margin-top: 2px;
        }

        .pxa-status-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .pxa-avatar {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 15%, transparent);
          color: var(--dsw-alias-brand-primary, #4d6bfe);
          font-weight: 600;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .pxa-user-info {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
          flex: 1;
        }

        .pxa-user-name {
          font-size: 15px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-user-sub {
          font-size: 12px;
          color: var(--dsw-alias-label-tertiary, #81858c);
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .pxa-badge-success {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 500;
          background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea043) 12%, transparent);
          color: var(--dsw-alias-state-success-primary, #2ea043);
        }

        .pxa-status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: currentColor;
        }

        .pxa-stats {
          display: flex;
          gap: 10px;
          margin-top: 14px;
        }

        .pxa-stat {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          padding: 10px 12px;
          border-radius: var(--dsw-radius-md, 8px);
          background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06));
          border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.18));
        }

        .pxa-stat-value {
          font-size: 18px;
          font-weight: 600;
          line-height: 1.2;
          color: var(--dsw-alias-label-primary, #18191b);
          font-variant-numeric: tabular-nums;
        }

        .pxa-stat-key {
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary, #81858c);
        }

        .pxa-groups-wrap {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 10px;
        }

        .pxa-groups-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--dsw-alias-label-secondary, #4b4f58);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .pxa-groups-count {
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary, #81858c);
          font-weight: normal;
        }

        .pxa-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-content: flex-start;
          max-height: 148px;
          overflow-y: auto;
          padding: 10px;
          border-radius: var(--dsw-radius-md, 8px);
          border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.18));
          background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.04));
          scrollbar-width: thin;
        }

        .pxa-chip {
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 500;
          line-height: 1.5;
          white-space: nowrap;
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08));
          border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.2));
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-otp-input {
          letter-spacing: 6px;
          font-size: 20px;
          font-weight: 600;
          text-align: center;
          height: 44px;
          font-family: var(--dsw-font-mono, monospace);
        }

        .pxa-id-card {
          flex-direction: row;
          align-items: center;
          gap: 12px;
        }

        .pxa-id-side {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 6px;
          flex-shrink: 0;
        }

        .pxa-link {
          font-size: 13px;
          color: var(--dsw-alias-label-primary, #18191b);
          text-decoration: none;
        }

        .pxa-link:hover { text-decoration: underline; }

        .pxa-balance-card { gap: 0; padding: 0 20px; }

        .pxa-balance-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 20px 0;
          border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15));
        }

        .pxa-balance-label {
          font-size: 14px;
          color: var(--dsw-alias-label-primary, #18191b);
        }

        .pxa-balance-value {
          font-size: 24px;
          font-weight: 600;
          line-height: 32px;
          font-variant-numeric: tabular-nums;
          color: var(--dsw-alias-label-primary, #18191b);
          transition: opacity .15s ease;
        }

        .pxa-balance-value.dim { opacity: .45; }

        .pxa-balance-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 0;
        }

        .pxa-balance-meta {
          min-width: 0;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary, #81858c);
        }

        .pxa-actions.tight { padding-top: 0; flex-shrink: 0; }

        a.pxa-btn { text-decoration: none; }

        .pxa-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 0 4px;
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary, #81858c);
        }

        .pxa-text-btn {
          flex-shrink: 0;
          padding: 0;
          border: none;
          background: transparent;
          font: inherit;
          font-size: 12px;
          cursor: pointer;
          color: var(--dsw-alias-label-secondary, #585a60);
        }

        .pxa-text-btn.danger { color: var(--dsw-alias-state-error-primary, #d54941); }
        .pxa-text-btn:hover:not(:disabled) { text-decoration: underline; }
        .pxa-text-btn:disabled { opacity: .5; cursor: not-allowed; }

        .pxa-empty-hint {
          padding: 16px;
          text-align: center;
          color: var(--dsw-alias-label-tertiary, #81858c);
          border: 1px dashed var(--dsw-alias-border-l3, rgba(128,128,128,0.2));
          border-radius: var(--dsw-radius-md, 8px);
          font-size: 13px;
        }

        .pxa-input.narrow { max-width: 220px; font-variant-numeric: tabular-nums; }

        .pxa-textarea {
          box-sizing: border-box;
          width: 100%;
          min-height: 92px;
          padding: 8px 12px;
          border-radius: var(--dsw-radius-md, 8px);
          border: 1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25));
          background: var(--dsw-alias-bg-layer-1, #ffffff);
          color: var(--dsw-alias-label-primary, #18191b);
          font-size: 13px;
          line-height: 20px;
          font-family: var(--dsw-font-mono, monospace);
          outline: none;
          resize: vertical;
          transition: border-color .15s ease, box-shadow .15s ease;
        }

        .pxa-textarea:focus {
          border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 18%, transparent);
        }

        .pxa-textarea::placeholder { color: var(--dsw-alias-label-dimmed, #9ca3af); opacity: 1; }
        .pxa-textarea:disabled { opacity: 0.6; cursor: not-allowed; }

        .pxa-hint {
          font-size: 12px;
          line-height: 18px;
          color: var(--dsw-alias-label-tertiary, #81858c);
          margin: 0;
        }

        .pxa-saved {
          font-size: 12px;
          color: var(--dsw-alias-state-success-primary, #2ea043);
        }

        .pxa-switch {
          position: relative;
          flex-shrink: 0;
          width: 40px;
          height: 22px;
          padding: 0;
          border: none;
          border-radius: 999px;
          cursor: pointer;
          background: var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
          transition: background-color .15s ease;
        }

        .pxa-switch.on {
          background: var(--dsw-alias-button-primary-fill, #4d6bfe);
        }

        .pxa-switch:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .pxa-switch-knob {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.25);
          transition: transform .15s ease;
        }

        .pxa-switch.on .pxa-switch-knob { transform: translateX(18px); }

        .pxa-switch-state {
          font-size: 12px;
          font-weight: normal;
          color: var(--dsw-alias-label-tertiary, #81858c);
        }
      `
      document.head.appendChild(style)
      return () => style.remove()
    }

    const msg = (e) => (e && e.message) ? e.message : String(e)
    const authOf = (section) => (section && section.auth) ? section.auth : { state: 'none', message: '', user: '', groups: [], models: -1 }
    const fillText = (t, key, vars) => Object.entries(vars).reduce(
      (text, [k, v]) => text.split('{' + k + '}').join(String(v)), t(key))

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

    const LayersIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('polygon', { points: '12 2 2 7 12 12 22 7 12 2' }),
      h('polyline', { points: '2 17 12 22 22 17' }),
      h('polyline', { points: '2 12 12 17 22 12' })
    )

    function ContextCard(props) {
      const { api, t, section, reload } = props
      const stored = Number(section && section.contextWindow)
      const currentWindow = Number.isSafeInteger(stored) && stored > 0 ? stored : DEFAULT_CONTEXT_WINDOW
      const storedRules = section && section.contextWindows
      const currentRules = storedRules && typeof storedRules === 'object' ? storedRules : {}
      const sourceKey = currentWindow + '\n' + formatRules(currentRules)
      const fresh = () => ({ window: String(currentWindow), rules: formatRules(currentRules), dirty: false, source: sourceKey })
      const [form, setForm] = useState(fresh)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)

      // Follow the stored value until the user edits: a host status write
      // landing mid-edit must not wipe what they typed.
      useEffect(() => {
        setForm((f) => (f.dirty || f.source === sourceKey ? f : fresh()))
      }, [sourceKey])

      const commit = async (windowValue, rules) => {
        setSaving(true)
        setError(null)
        setSaved(false)
        try {
          await api.settings.mutate(NS, [
            { op: 'set', path: ['contextWindow'], value: windowValue },
            { op: 'set', path: ['contextWindows'], value: rules },
          ])
          const text = formatRules(rules)
          setForm({ window: String(windowValue), rules: text, dirty: false, source: windowValue + '\n' + text })
          setSaved(true)
          // Refetch the section so the summary shows the stored value even if
          // no settings/document-updated event reaches this page.
          if (typeof reload === 'function') void reload()
        } catch (e) {
          setError(msg(e))
        } finally {
          setSaving(false)
        }
      }
      const save = () => {
        const windowValue = parseTokens(form.window)
        if (windowValue === undefined || windowValue < MIN_CONTEXT_WINDOW) {
          setSaved(false)
          setError(t('err.ctx.default'))
          return
        }
        const parsed = parseRules(form.rules, t)
        if (parsed.error) {
          setSaved(false)
          setError(parsed.error)
          return
        }
        void commit(windowValue, parsed.rules)
      }
      const edit = (patch) => {
        setSaved(false)
        setForm((f) => ({ ...f, ...patch, dirty: true }))
      }
      const ruleCount = Object.keys(currentRules).length
      const isDefault = currentWindow === DEFAULT_CONTEXT_WINDOW && ruleCount === 0

      return h('div', { className: 'pxa-card' },
        h('div', { className: 'pxa-card-head' },
          h('div', { className: 'pxa-card-title' }, h(LayersIcon, null), t('ctx.title')),
          h('span', { className: 'pxa-hint' },
            fillText(t, 'ctx.summary', { window: currentWindow.toLocaleString(), rules: ruleCount })),
        ),
        h('p', { className: 'pxa-desc' }, t('ctx.desc')),
        error ? h('div', { className: 'pxa-banner err' }, error) : null,
        h('div', { className: 'pxa-form' },
          h('div', { className: 'pxa-field' },
            h('label', { className: 'pxa-label' }, t('ctx.default')),
            h('input', {
              className: 'pxa-input narrow',
              value: form.window,
              inputMode: 'numeric',
              placeholder: String(DEFAULT_CONTEXT_WINDOW),
              disabled: saving,
              onChange: (e) => edit({ window: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter' && !saving && form.dirty) save() },
            }),
          ),
          h('div', { className: 'pxa-field' },
            h('label', { className: 'pxa-label' }, t('ctx.overrides')),
            h('textarea', {
              className: 'pxa-textarea',
              value: form.rules,
              placeholder: t('ctx.overrides.placeholder'),
              spellCheck: false,
              disabled: saving,
              onChange: (e) => edit({ rules: e.target.value }),
            }),
            h('p', { className: 'pxa-hint' }, t('ctx.hint')),
          ),
          h('div', { className: 'pxa-actions' },
            h('button', { className: 'pxa-btn primary', disabled: saving || !form.dirty, onClick: save },
              saving ? t('ctx.saving') : t('ctx.save')),
            h('button', {
              className: 'pxa-btn',
              disabled: saving || (isDefault && !form.dirty),
              onClick: () => void commit(DEFAULT_CONTEXT_WINDOW, {}),
            }, t('ctx.reset')),
            saved ? h('span', { className: 'pxa-saved' }, t('ctx.saved')) : null,
          ),
        ),
      )
    }

    const SparkIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8' })
    )

    // GPT encrypted-reasoning passback. Off by default: the host sends the
    // site's replay token back only when this is on (index.js serializeAssistant).
    // The toggle writes the volatile `openaiReasoningReplay` field; the host
    // reads it live, so it applies from the next request without a reload.
    function ReplayCard(props) {
      const { api, t, section, reload } = props
      const stored = !!(section && section.openaiReasoningReplay)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      // Intended value while a write is in flight; null follows the stored one.
      const [optimistic, setOptimistic] = useState(null)
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

      return h('div', { className: 'pxa-card' },
        h('div', { className: 'pxa-card-head' },
          h('div', { className: 'pxa-card-title' }, h(SparkIcon, null), t('replay.title')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { className: 'pxa-switch-state' }, on ? t('replay.on') : t('replay.off')),
            h('button', {
              type: 'button',
              className: 'pxa-switch' + (on ? ' on' : ''),
              role: 'switch',
              'aria-checked': on,
              disabled: busy,
              onClick: toggle,
            }, h('span', { className: 'pxa-switch-knob' })),
          ),
        ),
        h('p', { className: 'pxa-desc' }, t('replay.desc')),
        error ? h('div', { className: 'pxa-banner err' }, error) : null,
      )
    }

    const RefreshIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('polyline', { points: '23 4 23 10 17 10' }),
      h('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' })
    )

    // Plugin updates. The host does the work (it reads release tags with git
    // and runs the plugin manager's update); this card only bumps
    // updateCheckAt / updateApplyAt and renders the `update` status the host
    // writes back. Nothing is checked unless the person asks.
    function UpdateCard(props) {
      const { api, t, section, reload } = props
      const u = (section && section.update) || {}
      const state = String(u.state || 'idle')
      const [confirming, setConfirming] = useState(false)
      const [sent, setSent] = useState(null)
      const [error, setError] = useState(null)
      // A request is pending until the host records serving it.
      const servedFor = (kind) => Number(kind === 'check' ? u.servedCheckAt : u.servedApplyAt) || 0
      const pending = sent !== null && sent.at > servedFor(sent.kind)
      useEffect(() => {
        if (!pending) return undefined
        // Poll as well, in case no settings/document-updated event reaches this page.
        const poll = setInterval(() => { if (typeof reload === 'function') void reload() }, 2000)
        const giveUp = setTimeout(() => setSent(null), 30000)
        return () => { clearInterval(poll); clearTimeout(giveUp) }
      }, [pending, reload])
      const busy = pending || state === 'checking' || state === 'updating'
      const request = (kind) => {
        const at = Date.now()
        setError(null)
        setConfirming(false)
        setSent({ kind, at })
        api.settings.mutate(NS, [{ op: 'set', path: [kind === 'check' ? 'updateCheckAt' : 'updateApplyAt'], value: at }])
          .catch((e) => { setSent(null); setError(msg(e)) })
      }

      const reason = u.message || '—'
      let line = t('upd.idle')
      let tone = null
      if (state === 'checking' || (pending && sent && sent.kind === 'check')) line = t('upd.checking')
      else if (state === 'latest') line = fillText(t, 'upd.latest', { version: u.latest || u.current })
      else if (state === 'available') { line = fillText(t, 'upd.available', { version: u.latest }); tone = 'info' }
      else if (state === 'unsupported') { line = fillText(t, 'upd.unsupported', { version: u.latest, reason }); tone = 'warn' }
      else if (state === 'error') { line = fillText(t, 'upd.error', { reason }); tone = 'err' }
      else if (state === 'updating') { line = fillText(t, 'upd.updating', { version: u.target }); tone = 'info' }
      else if (state === 'updated') { line = fillText(t, 'upd.updated', { version: u.current }); tone = 'info' }
      else if (state === 'restart') { line = fillText(t, 'upd.restart', { version: u.target }); tone = 'warn' }
      else if (state === 'failed') { line = fillText(t, 'upd.failed', { reason }); tone = 'err' }
      const checkedAt = Number(u.checkedAt) || 0
      const available = state === 'available' && !!u.latest

      return h('div', { className: 'pxa-card' },
        h('div', { className: 'pxa-card-head' },
          h('div', { className: 'pxa-card-title' }, h(RefreshIcon, null), t('upd.title')),
          u.current ? h('span', { className: 'pxa-hint' }, fillText(t, 'upd.version', { version: u.current })) : null,
        ),
        tone ? h('div', { className: 'pxa-banner ' + tone }, line) : h('p', { className: 'pxa-desc' }, line),
        available ? h('p', { className: 'pxa-hint' }, t('upd.availableHint')) : null,
        error ? h('div', { className: 'pxa-banner err' }, error) : null,
        h('div', { className: 'pxa-actions' },
          available && confirming
            ? h(React.Fragment, null,
              h('button', { className: 'pxa-btn primary', disabled: busy, onClick: () => request('apply') }, t('upd.confirm')),
              h('button', { className: 'pxa-btn', disabled: busy, onClick: () => setConfirming(false) }, t('upd.cancel')))
            : available
              ? h('button', { className: 'pxa-btn primary', disabled: busy, onClick: () => setConfirming(true) },
                fillText(t, 'upd.apply', { version: u.latest }))
              : null,
          !(available && confirming)
            ? h('button', { className: 'pxa-btn', disabled: busy, onClick: () => request('check') }, t('upd.check'))
            : null,
          checkedAt > 0 && !busy
            ? h('span', { className: 'pxa-hint' }, fillText(t, 'upd.checkedAt', {
              time: new Date(checkedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            }))
            : null,
        ),
      )
    }

    function PixelSection(props) {
      const { api, remote, t } = props
      const [view, setView] = useState({ status: 'loading', error: null, section: null, creds: {} })
      const [form, setForm] = useState({ username: '', password: '', otp: '' })
      const [showPassword, setShowPassword] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
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

      const run = useCallback(async (fn) => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
        } catch (error) {
          setNotice(msg(error))
        } finally {
          setBusy(false)
        }
      }, [])

      const login = () => run(async () => {
        const username = form.username.trim()
        const password = form.password
        if (!username || !password) {
          setNotice(t('err.required'))
          return
        }
        await api.settings.mutate(NS, [{ op: 'set', path: ['username'], value: username }])
        await api.credentials.set(REFS.password, password)
        setForm((f) => ({ ...f, password: '' }))
      })

      const verify = () => run(async () => {
        const code = form.otp.trim()
        if (!code) {
          setNotice(t('err.requiredOtp'))
          return
        }
        await api.credentials.set(REFS.otp, code)
        setForm((f) => ({ ...f, otp: '' }))
      })

      const cancelChallenge = () => run(async () => {
        await api.credentials.unset(REFS.otp)
        await api.credentials.unset(REFS.password)
        await api.settings.mutate(NS, [
          { op: 'set', path: ['auth'], value: { state: 'none', message: '', user: '', groups: [], models: -1 } },
        ])
        setForm({ username: '', password: '', otp: '' })
      })

      // Sign-out order matters: raise signOutAt FIRST, because the host must
      // still hold the live access token and refresh cookie when it revokes the
      // site session. Clearing credentials first would tear the session down
      // locally and leave the site session alive.
      const logout = () => run(async () => {
        await api.settings.mutate(NS, [
          { op: 'set', path: ['signOutAt'], value: Date.now() },
          { op: 'set', path: ['username'], value: '' },
          { op: 'set', path: ['auth'], value: { state: 'none', message: '', user: '', groups: [], models: -1 } },
        ])
        for (const ref of Object.values(REFS)) {
          await api.credentials.unset(ref)
        }
      })

      // Ask the host to refetch balance + groups. The host serves each newer
      // refreshAt once; the page re-renders when the auth status it writes
      // lands (settings/document-updated). `refreshing` clears on that update
      // or after a timeout, whichever comes first.
      const [refreshing, setRefreshing] = useState(false)
      const refreshTimer = useRef(null)
      const profileStamp = (((view.section || {}).auth || {}).profile || {}).updatedAt || 0
      const requestRefresh = useCallback(() => {
        setRefreshing(true)
        clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => setRefreshing(false), 15000)
        api.settings.mutate(NS, [{ op: 'set', path: ['refreshAt'], value: Date.now() }])
          .catch((error) => { setRefreshing(false); setNotice(msg(error)) })
      }, [api])
      useEffect(() => { setRefreshing(false) }, [profileStamp])
      useEffect(() => () => clearTimeout(refreshTimer.current), [])

      // Opening the page with a balance older than 5 minutes refreshes once.
      const autoRefreshed = useRef(false)
      const authState = ((view.section || {}).auth || {}).state
      useEffect(() => {
        if (autoRefreshed.current || view.status !== 'ready' || authState !== 'ok') return
        autoRefreshed.current = true
        if (Date.now() - profileStamp > 5 * 60_000) requestRefresh()
      }, [view.status, authState, profileStamp, requestRefresh])

      if (view.status === 'loading') {
        return h('div', { className: 'pxa-section' },
          h('div', { className: 'pxa-header' },
            h('div', { className: 'pxa-header-top' },
              h('h2', { className: 'pxa-title' }, t('title')),
              h('div', { className: 'pxa-site-badge' }, h(GlobeIcon, null), 'api.ai-pixel.online'),
            ),
            h('p', { className: 'pxa-desc' }, t('subtitle')),
          ),
          h('div', { className: 'pxa-card' },
            h('div', { className: 'pxa-desc' }, t('status.loading')),
          ),
        )
      }

      if (view.status === 'error') {
        return h('div', { className: 'pxa-section' },
          h('div', { className: 'pxa-header' },
            h('div', { className: 'pxa-header-top' },
              h('h2', { className: 'pxa-title' }, t('title')),
              h('div', { className: 'pxa-site-badge' }, h(GlobeIcon, null), 'api.ai-pixel.online'),
            ),
            h('p', { className: 'pxa-desc' }, t('subtitle')),
          ),
          h('div', { className: 'pxa-card' },
            h('div', { className: 'pxa-banner err' }, view.error),
            h('div', { className: 'pxa-actions' },
              h('button', { className: 'pxa-btn', onClick: () => void load() }, t('action.refresh')),
            ),
          ),
        )
      }

      const auth = authOf(view.section)
      const username = (view.section && view.section.username) || ''

      // 1. Form Card (Logged Out)
      const formCard = h('div', { className: 'pxa-card' },
        h('div', { className: 'pxa-card-head' },
          h('div', { className: 'pxa-card-title' },
            h(LockIcon, null),
            t('card.loginTitle'),
          ),
        ),
        h('div', { className: 'pxa-form' },
          h('div', { className: 'pxa-field' },
            h('label', { className: 'pxa-label' }, t('field.username')),
            h('div', { className: 'pxa-input-wrap' },
              h('input', {
                className: 'pxa-input',
                value: form.username,
                placeholder: t('field.username.placeholder'),
                autoComplete: 'username',
                disabled: busy,
                onChange: (e) => setForm((f) => ({ ...f, username: e.target.value })),
                onKeyDown: (e) => { if (e.key === 'Enter' && !busy) login() },
              }),
            ),
          ),
          h('div', { className: 'pxa-field' },
            h('label', { className: 'pxa-label' }, t('field.password')),
            h('div', { className: 'pxa-input-wrap' },
              h('input', {
                className: 'pxa-input has-toggle',
                type: showPassword ? 'text' : 'password',
                value: form.password,
                placeholder: t('field.password.placeholder'),
                autoComplete: 'current-password',
                disabled: busy,
                onChange: (e) => setForm((f) => ({ ...f, password: e.target.value })),
                onKeyDown: (e) => { if (e.key === 'Enter' && !busy) login() },
              }),
              h('button', {
                type: 'button',
                className: 'pxa-toggle-btn',
                title: showPassword ? t('action.hidePassword') : t('action.showPassword'),
                tabIndex: -1,
                onClick: () => setShowPassword((v) => !v),
              }, showPassword ? h(EyeOffIcon, null) : h(EyeIcon, null)),
            ),
          ),
          h('div', { className: 'pxa-actions' },
            h('button', {
              className: 'pxa-btn primary',
              disabled: busy,
              onClick: login,
            }, busy ? t('action.loggingIn') : t('action.login')),
          ),
        ),
        h('div', { className: 'pxa-security-hint' },
          h(ShieldIcon, null),
          h('span', null, t('hint.session')),
        ),
      )

      // 2. 2FA Challenge Card
      const otpCard = h('div', { className: 'pxa-card' },
        h('div', { className: 'pxa-card-head' },
          h('div', { className: 'pxa-card-title' },
            h(KeyIcon, null),
            t('card.otpTitle'),
          ),
        ),
        h('div', { className: 'pxa-banner warn' },
          auth.message || t('status.2fa'),
        ),
        h('div', { className: 'pxa-form' },
          h('div', { className: 'pxa-field' },
            h('label', { className: 'pxa-label' }, t('field.otp')),
            h('div', { className: 'pxa-input-wrap' },
              h('input', {
                className: 'pxa-input pxa-otp-input',
                value: form.otp,
                placeholder: t('field.otp.placeholder'),
                inputMode: 'numeric',
                autoComplete: 'one-time-code',
                autoFocus: true,
                disabled: busy,
                onChange: (e) => setForm((f) => ({ ...f, otp: e.target.value })),
                onKeyDown: (e) => { if (e.key === 'Enter' && !busy) verify() },
              }),
            ),
          ),
          h('div', { className: 'pxa-actions' },
            h('button', {
              className: 'pxa-btn primary',
              disabled: busy,
              onClick: verify,
            }, busy ? t('action.verifying') : t('action.verify')),
            h('button', {
              className: 'pxa-btn',
              disabled: busy,
              onClick: cancelChallenge,
            }, t('action.cancel')),
          ),
        ),
      )

      // 3. Logged in: identity card, balance card, context window card.
      const fill = (key, vars) => Object.entries(vars).reduce(
        (text, [k, v]) => text.split('{' + k + '}').join(String(v)), t(key))
      const profile = auth.profile || {}
      const displayName = profile.name || auth.user || username || '—'
      const userInitial = displayName.charAt(0).toUpperCase()
      const groupCount = typeof auth.groupCount === 'number' && auth.groupCount > 0
        ? auth.groupCount
        : (auth.groups || []).length
      const modelCount = typeof auth.models === 'number' ? auth.models : -1
      const idLine = [
        profile.id ? 'ID ' + profile.id : '',
        profile.group ? fill('ok.userGroup', { group: profile.group }) : '',
      ].filter(Boolean).join(' · ')
      const usageLine = profile.updatedAt
        ? [
          profile.used ? fill('ok.used', { used: profile.used }) : '',
          fill('ok.requests', { count: Number(profile.requests || 0).toLocaleString() }),
        ].filter(Boolean).join(' · ')
        : ''
      const updatedLine = refreshing
        ? t('ok.updating')
        : profile.updatedAt
          ? fill('ok.updated', { time: new Date(profile.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
          : ''
      const updateCard = h(UpdateCard, { api, t, section: view.section, reload: load })
      const statusCard = h(React.Fragment, null,
        h('div', { className: 'pxa-card pxa-id-card' },
          h('div', { className: 'pxa-avatar' }, userInitial),
          h('div', { className: 'pxa-user-info' },
            h('div', { className: 'pxa-user-name' }, displayName),
            idLine ? h('div', { className: 'pxa-user-sub' }, idLine) : null,
          ),
          h('div', { className: 'pxa-id-side' },
            h('div', { className: 'pxa-badge-success' },
              h('span', { className: 'pxa-status-dot' }),
              t('status.ok'),
            ),
            h('a', { className: 'pxa-link', href: SITE_URL + '/', target: '_blank', rel: 'noreferrer' },
              t('action.openSite') + ' ↗'),
          ),
        ),
        h('div', { className: 'pxa-card pxa-balance-card' },
          h('div', { className: 'pxa-balance-row' },
            h('span', { className: 'pxa-balance-label' }, t('ok.balance')),
            h('span', { className: 'pxa-balance-value' + (refreshing ? ' dim' : '') },
              profile.balance || t('ok.unknown')),
          ),
          h('div', { className: 'pxa-balance-foot' },
            h('span', { className: 'pxa-balance-meta' }, [usageLine, updatedLine].filter(Boolean).join(' · ')),
            h('div', { className: 'pxa-actions tight' },
              h('button', {
                className: 'pxa-btn',
                disabled: busy || refreshing,
                onClick: requestRefresh,
              }, t('action.refresh')),
              h('a', {
                className: 'pxa-btn primary',
                href: SITE_URL + '/wallet',
                target: '_blank',
                rel: 'noreferrer',
              }, t('action.topup')),
            ),
          ),
        ),
        h(ContextCard, { api, t, section: view.section, reload: load }),
        h(ReplayCard, { api, t, section: view.section, reload: load }),
        updateCard,
        h('div', { className: 'pxa-footer' },
          h('span', null, groupCount > 0
            ? (modelCount >= 0
              ? fill('ok.mounted', { groups: groupCount, models: modelCount })
              : fill('ok.mountedNoModels', { groups: groupCount }))
            : ''),
          h('button', { className: 'pxa-text-btn danger', disabled: busy, onClick: logout }, t('action.logout')),
        ),
      )

      // Main container assembly
      const elements = [
        h('div', { key: 'hdr', className: 'pxa-header' },
          h('div', { className: 'pxa-header-top' },
            h('h2', { className: 'pxa-title' }, t('title')),
            h('div', { className: 'pxa-site-badge' }, h(GlobeIcon, null), 'api.ai-pixel.online'),
          ),
          h('p', { className: 'pxa-desc' }, t('subtitle')),
        ),
      ]

      if (notice) {
        elements.push(h('div', { key: 'err-notice', className: 'pxa-banner err' }, notice))
      }

      if (auth.state === '2fa') {
        elements.push(h(React.Fragment, { key: 'otp-card' }, otpCard))
        elements.push(h(React.Fragment, { key: 'update-card' }, updateCard))
      } else if (auth.state === 'ok') {
        elements.push(h(React.Fragment, { key: 'status-card' }, statusCard))
      } else {
        if (auth.state === 'error' && auth.message) {
          elements.push(h('div', { key: 'auth-err', className: 'pxa-banner err' }, auth.message))
        } else if (auth.state === 'pending') {
          elements.push(h('div', { key: 'auth-pending', className: 'pxa-banner info' }, t('status.pending')))
        } else if (auth.message) {
          elements.push(h('div', { key: 'auth-msg', className: 'pxa-banner info' }, auth.message))
        }
        elements.push(h(React.Fragment, { key: 'login-card' }, formCard))
        elements.push(h(React.Fragment, { key: 'update-card' }, updateCard))
      }

      return h('div', { className: 'pxa-section' }, elements)
    }

    // ---------------------------------------------------------------------
    // Two-column model picker (groups left with billing ratio, models right).
    // ---------------------------------------------------------------------

    const RATIO_MARK = ' ×'
    const MS_STYLE_ID = PLUGIN_ID + '/model-split.css'

    // Host route names carry the ratio as `名称 ×0.5` (index.js formatRatio).
    function splitRatio(name) {
      const at = name.lastIndexOf(RATIO_MARK)
      if (at <= 0) return { name, ratio: '' }
      return { name: name.slice(0, at), ratio: name.slice(at + RATIO_MARK.length) }
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
      const { locked, available, directory, load, select } = props
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

      const groups = React.useMemo(() => orderProviders(state.groups || []).map((g) => {
        const label = g.id === 'deepseek-account' ? 'DeepSeek 账号' : String(g.name || g.id)
        const parts = splitRatio(label)
        // PIXEL routes are `pixel/<site group key>`; the key is the group ID.
        const key = String(g.id).startsWith('pixel/') ? String(g.id).slice(6) : ''
        return { id: g.id, key, models: g.models || [], name: parts.name, ratio: parts.ratio }
      }), [state.groups])

      const current = state.current
      const currentGroup = current ? groups.find((g) => g.id === current.provider) : undefined
      const currentModel = currentGroup ? currentGroup.models.find((m) => m.id === current.model) : undefined
      const reasoning = currentModel && currentModel.reasoning
      const effort = (current && current.reasoningEffort) || (reasoning && reasoning.defaultEffort)
      const effortName = reasoning
        ? ((reasoning.efforts || []).find((e) => e.id === effort) || {}).name || effort || 'Default'
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
            ? '当前会话已被其他 DSH 实例占用，请退出其他实例后重试'
            : '切换失败：' + ((res.error && res.error.message) || 'unknown'))
        }, (e) => setError('切换失败：' + msg(e)))
      }
      const chooseModel = (group, model) => {
        if (current && current.provider === group.id && current.model === model.id) {
          close(true)
          return
        }
        const def = model.reasoning && model.reasoning.defaultEffort
        submit({ provider: group.id, model: model.id, ...(def === undefined ? {} : { reasoningEffort: def }) })
      }
      const chooseEffort = (id) => {
        if (!current || id === effort) return
        submit({ provider: current.provider, model: current.model, ...(id === undefined ? {} : { reasoningEffort: id }) })
      }

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
        : loading ? '正在加载模型…' : '请选择模型'
      const triggerTitle = currentModel
        ? `${currentGroup.name}${currentGroup.ratio ? ' ×' + currentGroup.ratio : ''} · ${label}${effortName ? ' · ' + effortName : ''}`
        : label

      rowRefs.current = []
      const menu = open && pos ? createPortal(h('div', {
        ref: menuRef,
        className: 'pxm-menu',
        role: 'dialog',
        'aria-label': '选择模型',
        style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
        onKeyDown,
      },
        h('input', {
          ref: searchRef,
          className: 'pxm-search',
          placeholder: '搜索模型…（↑↓ 选择，Alt+←→ 切换分组，Enter 确认）',
          value: query,
          onChange: (e) => { setQuery(e.target.value); setHl(0) },
        }),
        error ? h('div', { className: 'pxm-warn' }, h('span', null, error)) : null,
        state.error ? h('div', { className: 'pxm-warn' },
          h('span', null, '模型目录加载失败：' + state.error),
          h('button', { type: 'button', onClick: load }, '重试')) : null,
        (state.failures || []).map((f) => h('div', { key: 'f:' + f.id, className: 'pxm-warn' },
          h('span', null, `${splitRatio(String(f.name || f.id)).name} 加载失败：${f.message}`),
          h('button', { type: 'button', onClick: load }, '重试'))),
        h('div', { className: 'pxm-body' },
          h('div', { className: 'pxm-col pxm-left', role: 'listbox', 'aria-label': '模型分组' },
            h('div', { className: 'pxm-heading' }, '模型分组'),
            visibleGroups.length === 0
              ? h('div', { className: 'pxm-note' }, loading ? '正在刷新模型列表…' : (groups.length ? '没有匹配的分组' : '暂无可用模型'))
              : visibleGroups.map((g) => h('button', {
                key: g.id,
                type: 'button',
                role: 'option',
                'aria-selected': g === shownGroup,
                className: 'pxm-row' + (g === shownGroup ? ' active' : ''),
                title: `${g.name}${g.key ? '\nID：' + g.key : ''}${g.ratio ? '\n倍率：×' + g.ratio : ''}`,
                onClick: () => { setActiveGroup(g.id); setHl(0); searchRef.current && searchRef.current.focus() },
              },
                h('span', { className: 'pxm-gtext' },
                  h('span', { className: 'pxm-name' }, g.name),
                  g.key && g.key !== g.name ? h('span', { className: 'pxm-gid' }, 'ID: ' + g.key) : null),
                current && current.provider === g.id ? h('span', { className: 'pxm-dot', title: '当前模型所在分组' }) : null,
                g.ratio ? h('span', { className: 'pxm-ratio ' + ratioTone(g.ratio) }, '×' + g.ratio) : null,
              ))),
          h('div', { className: 'pxm-col pxm-right', role: 'listbox', 'aria-label': '模型' },
            h('div', { className: 'pxm-heading' },
              shownGroup
                ? [shownGroup.name,
                  shownGroup.key && shownGroup.key !== shownGroup.name ? 'ID ' + shownGroup.key : '',
                  shownGroup.ratio ? '倍率 ×' + shownGroup.ratio : ''].filter(Boolean).join(' · ')
                : '模型'),
            loading && shownModels.length === 0 ? h('div', { className: 'pxm-note' }, '正在刷新模型列表…') : null,
            !loading && shownGroup && shownModels.length === 0 ? h('div', { className: 'pxm-note' }, '该分组暂无模型') : null,
            shownModels.map((m, i) => {
              const selected = current && shownGroup && current.provider === shownGroup.id && current.model === m.id
              const pending = state.pending && shownGroup && state.pending.provider === shownGroup.id && state.pending.model === m.id
              return h('button', {
                key: m.id,
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
                pending ? h('span', { className: 'pxm-note', style: { padding: 0 } }, '切换中…') : selected ? h(SmallCheck) : null,
              )
            }),
          ),
        ),
        reasoning && (reasoning.efforts || []).length > 0
          ? h('div', { className: 'pxm-foot' },
            h('span', null, '推理等级'),
            reasoning.defaultEffort === undefined
              ? h('button', { type: 'button', disabled: busy, className: 'pxm-chip' + (effort === undefined ? ' on' : ''), onClick: () => chooseEffort(undefined) }, 'Default')
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
          title: triggerTitle,
          disabled: locked,
          onClick: () => (open ? close(true) : show()),
        },
          h('span', { className: 'pxm-trigger-label' }, label),
          effortName && currentModel ? h('span', { className: 'pxm-trigger-effort' }, effortName) : null,
          h(ChevronIcon, { className: 'pxm-chevron' + (open ? ' open' : '') + (busy ? '' : '') }),
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

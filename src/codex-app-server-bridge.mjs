import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  buildAskMessage,
  isLocalKeyword,
  loadConfig,
  makeTelegram,
  promptTelegramPermission,
  promptTelegramAsk,
  strings,
  writeSessionAllow,
} from '../hook/notify-telegram.mjs';

const BRIDGE_CLIENT_INFO = {
  name: 'cc_notify_telegram_codex_bridge',
  title: 'cc-notify-telegram Codex bridge',
  version: '0.1.0',
};

function writeJson(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function patchInitializeRequest(message) {
  if (message?.method !== 'initialize' || !message.params || typeof message.params !== 'object') return message;
  const params = { ...message.params };
  params.clientInfo = params.clientInfo || BRIDGE_CLIENT_INFO;
  params.capabilities = {
    ...(params.capabilities || {}),
    experimentalApi: true,
  };
  return { ...message, params };
}

export function appServerQuestionsToAsk(questions = []) {
  return questions.map((q) => ({
    question: q.header ? `${q.header}: ${q.question}` : q.question,
    options: Array.isArray(q.options)
      ? q.options.map((opt) => ({ label: opt.label, description: opt.description }))
      : [],
    multiSelect: false,
    appServerId: q.id,
    isOther: Boolean(q.isOther),
    isSecret: Boolean(q.isSecret),
  }));
}

export function resolveAppServerAnswers(raw, questions = []) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const byQuestion = new Map();
  let allTokens = parts.length > 0;

  for (const part of parts) {
    const match = part.match(/^(\d*)([A-Za-z])$/);
    if (!match) {
      allTokens = false;
      break;
    }
    const qIndex = match[1] ? Number(match[1]) - 1 : questions.length === 1 ? 0 : -1;
    const oIndex = match[2].toUpperCase().charCodeAt(0) - 65;
    const option = questions[qIndex]?.options?.[oIndex];
    if (!option) {
      allTokens = false;
      break;
    }
    byQuestion.set(qIndex, option.label);
  }

  if (allTokens && byQuestion.size) {
    return questions.map((_, index) => byQuestion.get(index) || '');
  }

  if (questions.length === 1) return [text];

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === questions.length) return lines;

  return null;
}

export async function answerToolRequestUserInput(
  message,
  { cfg, tg, env = process.env, home, promptAsk = promptTelegramAsk } = {}
) {
  const params = message.params || {};
  const questions = appServerQuestionsToAsk(params.questions || []);
  if (!questions.length) return null;

  const str = strings(cfg);
  const text = buildAskMessage(questions, {
    project: 'codex-app-server',
    suffix: String(params.turnId || params.threadId || '').slice(-4),
    str,
    providerId: 'codex',
  });

  const prompt = await promptAsk({
    payload: { session_id: params.threadId || params.turnId || '' },
    cfg,
    tg,
    env,
    home,
    questions,
    text,
  });
  if (prompt.type !== 'ok') return null;

  const { outcome, anchorId, pendingFile } = prompt;
  const cleanupPending = () => {
    try {
      unlinkSync(pendingFile);
    } catch {
      // Pending may already have been swept by another process.
    }
  };
  if (outcome.type !== 'reply' || isLocalKeyword(outcome.text)) {
    await tg
      .editMessageText(anchorId, outcome.type === 'timeout' ? str.timedOut : str.movedLocal)
      .catch(() => {});
    cleanupPending();
    return null;
  }

  const answers = resolveAppServerAnswers(outcome.text, questions);
  if (!answers || answers.some((answer) => !answer)) {
    await tg.editMessageText(anchorId, str.movedLocal).catch(() => {});
    cleanupPending();
    return null;
  }

  await tg.editMessageText(anchorId, str.answeredTg(outcome.text)).catch(() => {});
  cleanupPending();
  return { answers };
}

function appServerSessionId(params = {}) {
  return String(params.threadId || params.conversationId || params.turnId || params.callId || '');
}

function appServerSuffix(params = {}) {
  return String(params.turnId || params.itemId || params.callId || params.approvalId || '').slice(-4);
}

function commandToString(command) {
  return Array.isArray(command) ? command.join(' ') : String(command || '');
}

export function appServerApprovalToPermissionPayload(message) {
  const params = message.params || {};
  const sessionId = appServerSessionId(params);
  const base = {
    sessionId,
    payload: {
      session_id: sessionId,
      cwd: params.cwd,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId || params.callId,
    },
    project: 'codex-app-server',
    suffix: appServerSuffix(params),
  };

  if (message.method === 'item/commandExecution/requestApproval') {
    return {
      ...base,
      toolName: 'Command',
      toolInput: {
        command: commandToString(params.command),
        cwd: params.cwd,
        reason: params.reason,
        approvalId: params.approvalId,
        commandActions: params.commandActions,
        networkApprovalContext: params.networkApprovalContext,
        additionalPermissions: params.additionalPermissions,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
      },
    };
  }

  if (message.method === 'item/fileChange/requestApproval') {
    return {
      ...base,
      toolName: 'FileChange',
      toolInput: {
        reason: params.reason,
        grantRoot: params.grantRoot,
      },
    };
  }

  if (message.method === 'item/permissions/requestApproval') {
    return {
      ...base,
      toolName: 'Permissions',
      toolInput: {
        cwd: params.cwd,
        reason: params.reason,
        permissions: params.permissions,
        environmentId: params.environmentId,
      },
    };
  }

  if (message.method === 'execCommandApproval') {
    return {
      ...base,
      toolName: 'Command',
      toolInput: {
        command: commandToString(params.command),
        cwd: params.cwd,
        reason: params.reason,
        approvalId: params.approvalId,
        parsedCmd: params.parsedCmd,
      },
    };
  }

  if (message.method === 'applyPatchApproval') {
    return {
      ...base,
      toolName: 'FileChange',
      toolInput: {
        reason: params.reason,
        grantRoot: params.grantRoot,
        fileChanges: params.fileChanges,
      },
    };
  }

  return null;
}

function compactGrantedPermissions(requested = {}) {
  const granted = {};
  if (requested.network) granted.network = requested.network;
  if (requested.fileSystem) granted.fileSystem = requested.fileSystem;
  return granted;
}

export function appServerApprovalResponse(method, action, params = {}, str = strings({ lang: 'vi' })) {
  if (method === 'item/commandExecution/requestApproval') {
    if (action === 'd') return { decision: 'decline' };
    return { decision: action === 's' ? 'acceptForSession' : 'accept' };
  }

  if (method === 'item/fileChange/requestApproval') {
    if (action === 'd') return { decision: 'decline' };
    return { decision: action === 's' ? 'acceptForSession' : 'accept' };
  }

  if (method === 'item/permissions/requestApproval') {
    if (action === 'd') return { permissions: {}, scope: 'turn', strictAutoReview: true };
    return {
      permissions: compactGrantedPermissions(params.permissions),
      scope: action === 's' ? 'session' : 'turn',
    };
  }

  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    if (action === 'd') return { decision: { denied: { rejection: str.permDenyReason } } };
    return { decision: action === 's' ? 'approved_for_session' : 'approved' };
  }

  return null;
}

const APP_SERVER_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

function hhmm(ts) {
  return new Date(ts).toTimeString().slice(0, 5);
}

export async function answerAppServerApproval(
  message,
  { cfg, tg, env = process.env, home, promptPerm = promptTelegramPermission } = {}
) {
  if (!APP_SERVER_APPROVAL_METHODS.has(message?.method)) return null;

  const request = appServerApprovalToPermissionPayload(message);
  if (!request) return null;

  const prompt = await promptPerm({
    payload: request.payload,
    cfg,
    tg,
    env,
    home,
    toolName: request.toolName,
    toolInput: request.toolInput,
    project: request.project,
    suffix: request.suffix,
  });

  if (prompt.type === 'session-allow') {
    return appServerApprovalResponse(message.method, 'a', message.params, strings(cfg));
  }
  if (prompt.type !== 'ok') return null;

  const { outcome, anchorId, dir } = prompt;
  const str = strings(cfg);
  if (outcome.type !== 'callback' || outcome.action === 'l') {
    await tg
      .editMessageText(anchorId, outcome.type === 'timeout' ? str.permTimedOut : str.permMovedLocal)
      .catch(() => {});
    return null;
  }

  const who = outcome.fromName ? ` (${outcome.fromName})` : '';
  if (outcome.action === 'd') {
    await tg.editMessageText(anchorId, str.permDenied(who)).catch(() => {});
    return appServerApprovalResponse(message.method, 'd', message.params, str);
  }
  if (outcome.action === 's') {
    const until = writeSessionAllow(dir, request.sessionId, cfg.sessionAllowTtlMin);
    await tg.editMessageText(anchorId, str.permAllowedSession(who, hhmm(until))).catch(() => {});
    return appServerApprovalResponse(message.method, 's', message.params, str);
  }

  await tg.editMessageText(anchorId, str.permAllowed(who)).catch(() => {});
  return appServerApprovalResponse(message.method, 'a', message.params, str);
}

export async function handleServerRequest(message, context) {
  let result = null;
  if (message?.method === 'item/tool/requestUserInput') {
    result = await answerToolRequestUserInput(message, context);
  } else if (APP_SERVER_APPROVAL_METHODS.has(message?.method)) {
    result = await answerAppServerApproval(message, context);
  }
  if (!result) return null;
  return { id: message.id, result };
}

export async function runCodexAppServerBridge({
  codexBin = process.env.CODEX_BIN || 'codex',
  codexArgs = ['app-server', '--stdio'],
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  env = process.env,
  home,
} = {}) {
  const cfg = loadConfig({ providerId: 'codex', env, home });
  cfg.providerId = 'codex';
  const tg = makeTelegram(cfg);
  const upstream = spawn(codexBin, codexArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  upstream.stderr.on('data', (chunk) => error.write(chunk));
  upstream.on('error', (err) => {
    error.write(`codex app-server bridge failed: ${err.message}\n`);
  });

  const clientLines = createInterface({ input });
  clientLines.on('line', (line) => {
    const message = parseJsonLine(line);
    if (message) writeJson(upstream.stdin, patchInitializeRequest(message));
    else upstream.stdin.write(`${line}\n`);
  });
  clientLines.on('close', () => upstream.stdin.end());

  const serverLines = createInterface({ input: upstream.stdout });
  serverLines.on('line', (line) => {
    const message = parseJsonLine(line);
    if (!message) {
      output.write(`${line}\n`);
      return;
    }

    handleServerRequest(message, { cfg, tg, env, home })
      .then((response) => {
        if (response) writeJson(upstream.stdin, response);
        else writeJson(output, message);
      })
      .catch((err) => {
        error.write(`codex app-server bridge request failed: ${err.message}\n`);
        writeJson(output, message);
      });
  });

  return new Promise((resolve) => {
    upstream.on('exit', (code) => resolve(code === 0));
  });
}

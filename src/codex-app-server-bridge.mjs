import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  buildAskMessage,
  isLocalKeyword,
  loadConfig,
  makeTelegram,
  promptTelegramAsk,
  strings,
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

export async function handleServerRequest(message, context) {
  if (message?.method !== 'item/tool/requestUserInput') return null;
  const result = await answerToolRequestUserInput(message, context);
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

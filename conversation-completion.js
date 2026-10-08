/**
 * conversation-completion.js — backend conversation 完成信号
 *
 * 从 GET /backend-api/conversation/{id} 的 raw payload 提取
 * async_status / reasoning_status，供 status --wait 与 ResponseTracker 使用。
 * 不依赖 Puppeteer。
 */

'use strict';

function isAsyncStatusInProgress(asyncStatus) {
  return asyncStatus === 3 || (typeof asyncStatus === 'number' && asyncStatus > 0);
}

/**
 * 从 raw conversation payload 提取完成判定信号。
 * thoughts / reasoning 消息不会进入 snapshot.messages，必须从 mapping 单独收集。
 */
function extractConversationCompletion(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const mapping = payload.mapping && typeof payload.mapping === 'object'
    ? payload.mapping
    : {};
  let nodes = Object.values(mapping).filter((node) => node && node.message);
  // 有 current_node 时只检查当前分支，避免废弃分支的思考标记阻塞退出。
  if (payload.current_node && mapping[payload.current_node]) {
    const branch = [];
    const seen = new Set();
    let nodeId = payload.current_node;
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (node.message) branch.push(node);
      nodeId = node.parent;
    }
    nodes = branch.reverse();
  } else {
    nodes.sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
  }

  let workingTurnId = null;
  let latestTurnTime = -1;
  for (const node of nodes) {
    const meta = node.message.metadata || {};
    const turnId = meta.working_turn_id || meta.turn_exchange_id || null;
    const t = node.message.create_time ?? 0;
    if (turnId && t >= latestTurnTime) {
      latestTurnTime = t;
      workingTurnId = turnId;
    }
  }

  const currentTurnNodes = nodes.filter((node) => {
    const meta = node.message.metadata || {};
    const turnId = meta.working_turn_id || meta.turn_exchange_id || null;
    return !workingTurnId || !turnId || turnId === workingTurnId;
  });
  const latestAssistant = currentTurnNodes.filter(
    (node) => node.message.author?.role === 'assistant'
  ).at(-1)?.message;
  const hasFinalAssistant = Boolean(
    latestAssistant?.end_turn === true &&
    latestAssistant.status === 'finished_successfully' &&
    latestAssistant.metadata?.reasoning_status !== 'is_reasoning'
  );

  let hasReasoning = false;
  for (const node of currentTurnNodes) {
    const meta = node.message.metadata || {};
    if (!hasFinalAssistant && meta.reasoning_status === 'is_reasoning') {
      hasReasoning = true;
      break;
    }
  }

  return {
    asyncStatus: Object.prototype.hasOwnProperty.call(payload, 'async_status')
      ? payload.async_status
      : undefined,
    hasAsyncStatusField: Object.prototype.hasOwnProperty.call(payload, 'async_status'),
    hasReasoning,
    hasFinalAssistant,
    workingTurnId,
    currentNode: payload.current_node || null,
    updateTime: payload.update_time || null,
  };
}

/**
 * backend 完成门控。
 * true：当前 turn 已结束；false：仍在生成；null：信号不足，交给 DOM。
 *
 * thinking 阶段间 async_status 可能短暂变为 null，但不能据此完成。
 * 当前 turn 仍有 is_reasoning 时一律视为未完成。
 */
function isConversationTurnComplete(completion) {
  if (!completion) return null;
  if (isAsyncStatusInProgress(completion.asyncStatus)) return false;
  if (completion.hasReasoning) return false;
  if (completion.hasFinalAssistant) return true;
  if (completion.hasAsyncStatusField) {
    return !isAsyncStatusInProgress(completion.asyncStatus);
  }
  return null;
}

module.exports = {
  extractConversationCompletion,
  isConversationTurnComplete,
  isAsyncStatusInProgress,
};

// @bun
// Generated from pi-ai/pi-utils 18.8.7 by bun run build:cache-replay; do not edit.
/*!
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

// node_modules/@oh-my-pi/pi-ai/src/utils.ts
import { $env } from "@oh-my-pi/pi-utils";
import { isMalformedToolCallName, redactSensitiveCredentials } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isRecord } from "@oh-my-pi/pi-utils";
var NON_WHITESPACE_RE = /\S/;
function truncateResponseItemId(id, prefix) {
  if (id.length <= 64)
    return id;
  return `${prefix}_${Bun.hash(id).toString(36)}`;
}
function stripOpenAIResponsesOutputOnlyStatusesForReplay(items) {
  let sanitized;
  for (let index = 0;index < items.length; index++) {
    const item = items[index];
    const rejectsOutputStatus = item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call" || item.type === "compaction" || item.type === "compaction_summary";
    if (!rejectsOutputStatus || !Object.hasOwn(item, "status")) {
      sanitized?.push(item);
      continue;
    }
    if (!sanitized)
      sanitized = items.slice(0, index);
    const withoutStatus = { ...item };
    delete withoutStatus.status;
    sanitized.push(withoutStatus);
  }
  return sanitized ?? items;
}
function clampReplayItemImageDetail(item, supportsImageDetailOriginal) {
  if (supportsImageDetailOriginal)
    return item;
  if (item.type === "input_image" && item.detail === "original") {
    return { ...item, detail: "auto" };
  }
  if (item.type !== "message" || !Array.isArray(item.content))
    return item;
  let changed = false;
  const content = item.content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part))
      return part;
    const record = part;
    if (record.type !== "input_image" || record.detail !== "original")
      return part;
    changed = true;
    return { ...record, detail: "auto" };
  });
  return changed ? { ...item, content } : item;
}
function isOpenAIResponsesClientInputBoundary(item) {
  if (item.type === "message")
    return item.role !== "assistant";
  if (item.type === undefined && typeof item.role === "string")
    return item.role !== "assistant";
  switch (item.type) {
    case "input_text":
    case "input_image":
    case "input_file":
    case "input_audio":
    case "function_call_output":
    case "custom_tool_call_output":
    case "computer_call_output":
    case "local_shell_call_output":
    case "shell_call_output":
    case "apply_patch_call_output":
    case "mcp_approval_response":
    case "compaction":
    case "compaction_summary":
    case "compaction_trigger":
    case "item_reference":
      return true;
    case "additional_tools":
      return item.role !== "assistant";
    case "tool_search_output":
      return item.execution !== "server";
    default:
      return false;
  }
}
function collectOpenAIResponsesComputerLinkedReasoningItems(items, requireLaterOutput) {
  let computerCallsWithLaterOutputs;
  if (requireLaterOutput) {
    computerCallsWithLaterOutputs = new Set;
    const laterComputerOutputCallIds = new Set;
    for (let index = items.length - 1;index >= 0; index--) {
      const item = items[index];
      if (item.type === "computer_call_output" && typeof item.call_id === "string") {
        laterComputerOutputCallIds.add(item.call_id);
      } else if (item.type === "computer_call" && typeof item.id === "string" && typeof item.call_id === "string" && laterComputerOutputCallIds.has(item.call_id)) {
        computerCallsWithLaterOutputs.add(item);
      }
    }
  }
  const computerLinkedReasoningItems = new Set;
  const responseReasoningItems = [];
  for (const item of items) {
    if (isOpenAIResponsesClientInputBoundary(item)) {
      responseReasoningItems.length = 0;
    } else if (item.type === "reasoning") {
      responseReasoningItems.push(item);
    } else if (item.type === "computer_call" && typeof item.id === "string" && (!computerCallsWithLaterOutputs || computerCallsWithLaterOutputs.has(item))) {
      for (const reasoningItem of responseReasoningItems)
        computerLinkedReasoningItems.add(reasoningItem);
    }
  }
  return computerLinkedReasoningItems;
}
var provisionalOpenAIResponsesComputerReasoningItems = new WeakSet;
function sanitizeOpenAIResponsesHistoryItemsForReplay(items, options = {}) {
  const replayItems = dropMalformedOpenAIResponsesToolCalls(items);
  const supportsImageDetailOriginal = options.supportsImageDetailOriginal === true;
  const computerLinkedReasoningItems = options.supportsComputerUse === false ? undefined : collectOpenAIResponsesComputerLinkedReasoningItems(replayItems, false);
  const sanitized = replayItems.flatMap((item) => {
    const preserveForComputer = computerLinkedReasoningItems?.has(item) === true;
    const sanitizedItem = sanitizeOpenAIResponsesHistoryItemForReplay(item, supportsImageDetailOriginal, preserveForComputer);
    if (preserveForComputer && sanitizedItem?.type === "reasoning") {
      provisionalOpenAIResponsesComputerReasoningItems.add(sanitizedItem);
    }
    return sanitizedItem ? [sanitizedItem] : [];
  });
  return stripOpenAIResponsesOutputOnlyStatusesForReplay(sanitized);
}
function sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(items, options = {}) {
  const sanitized = sanitizeOpenAIResponsesHistoryItemsForReplay(items, options);
  let hasReplayableAssistantOutput = false;
  let hasEmptyAssistantMessage = false;
  for (const item of sanitized) {
    if (item.type === "reasoning")
      continue;
    if (isEmptyAssistantMessage(item)) {
      hasEmptyAssistantMessage = true;
      continue;
    }
    hasReplayableAssistantOutput = true;
  }
  if (!hasReplayableAssistantOutput)
    return;
  if (!hasEmptyAssistantMessage)
    return sanitized;
  return dropEmptyAssistantMessagesForReplay(sanitized);
}
function isEmptyAssistantMessage(item) {
  if (item.type !== "message" || item.role !== "assistant")
    return false;
  if (typeof item.content === "string")
    return !NON_WHITESPACE_RE.test(item.content);
  for (const part of item.content) {
    if (part.type === "output_text" && NON_WHITESPACE_RE.test(part.text))
      return false;
    if (part.type === "refusal" && NON_WHITESPACE_RE.test(part.refusal))
      return false;
  }
  return true;
}
function dropEmptyAssistantMessagesForReplay(items) {
  const kept = [];
  let pendingReasoning = [];
  let removedAssistantMessage = false;
  const flushReasoning = () => {
    kept.push(...pendingReasoning);
    pendingReasoning = [];
  };
  for (const item of items) {
    if (isOpenAIResponsesClientInputBoundary(item)) {
      pendingReasoning = [];
      removedAssistantMessage = false;
      kept.push(item);
      continue;
    }
    if (item.type === "reasoning") {
      if (removedAssistantMessage)
        pendingReasoning = [];
      removedAssistantMessage = false;
      pendingReasoning.push(item);
      continue;
    }
    if (isEmptyAssistantMessage(item)) {
      removedAssistantMessage = true;
      continue;
    }
    flushReasoning();
    removedAssistantMessage = false;
    kept.push(item);
  }
  return kept;
}
function isMalformedOpenAIResponsesToolCall(item) {
  return (item.type === "function_call" || item.type === "custom_tool_call") && isMalformedToolCallName(item.name);
}
function malformedResponsesCallKind(type) {
  if (type === "function_call")
    return "function";
  if (type === "custom_tool_call")
    return "custom";
  return;
}
function malformedResponsesOutputKind(type) {
  if (type === "function_call_output")
    return "function";
  if (type === "custom_tool_call_output")
    return "custom";
  return;
}
function isResponsesToolResultItem(type) {
  return type === "function_call_output" || type === "custom_tool_call_output" || type === "computer_call_output" || type === "local_shell_call_output" || type === "shell_call_output" || type === "apply_patch_call_output";
}
function breaksMalformedResponsesPairingWindow(item) {
  if (isResponsesToolResultItem(item.type))
    return false;
  return isOpenAIResponsesClientInputBoundary(item);
}
function dropMalformedOpenAIResponsesToolCalls(items) {
  let hasMalformed = false;
  for (const item of items) {
    if (isMalformedOpenAIResponsesToolCall(item)) {
      hasMalformed = true;
      break;
    }
  }
  if (!hasMalformed)
    return items;
  const dropQueues = new Map;
  const kept = [];
  for (const item of items) {
    const callKind = malformedResponsesCallKind(item.type);
    if (callKind) {
      const malformed = isMalformedOpenAIResponsesToolCall(item);
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId !== undefined) {
        const key = `${callKind}\x00${callId}`;
        const queue = dropQueues.get(key);
        if (queue)
          queue.push(malformed);
        else
          dropQueues.set(key, [malformed]);
      }
      if (malformed)
        continue;
      kept.push(item);
      continue;
    }
    const outputKind = malformedResponsesOutputKind(item.type);
    if (outputKind) {
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId !== undefined) {
        const key = `${outputKind}\x00${callId}`;
        const queue = dropQueues.get(key);
        if (queue && queue.length > 0) {
          const drop = queue.shift() === true;
          if (queue.length === 0)
            dropQueues.delete(key);
          if (drop)
            continue;
        }
      }
      kept.push(item);
      continue;
    }
    if (breaksMalformedResponsesPairingWindow(item))
      dropQueues.clear();
    kept.push(item);
  }
  return kept;
}
var validatedReplayArguments = new WeakMap;
function hasValidReplayArguments(item) {
  const args = item.arguments;
  if (typeof args !== "string")
    return false;
  if (validatedReplayArguments.get(item) === args)
    return true;
  if (args.trim().length === 0)
    return false;
  try {
    JSON.parse(args);
  } catch {
    return false;
  }
  validatedReplayArguments.set(item, args);
  return true;
}
function sanitizeOpenAIResponsesHistoryItemForReplay(item, supportsImageDetailOriginal, preserveReasoningItemIds) {
  if (isMalformedOpenAIResponsesToolCall(item)) {
    return;
  }
  if (item.type === "function_call") {
    if (!hasValidReplayArguments(item))
      return;
  }
  if (item.type === "item_reference")
    return;
  if (item.type === "image_generation_call")
    return sanitizeOpenAIResponsesImageGenerationCallForReplay(item);
  if (item.type === "reasoning") {
    return sanitizeOpenAIResponsesReasoningItemForReplay(item, preserveReasoningItemIds);
  }
  const { id: _id, ...sanitizedItem } = item;
  if (item.type === "computer_call" && typeof item.id === "string")
    sanitizedItem.id = item.id;
  return clampReplayItemImageDetail(sanitizedItem, supportsImageDetailOriginal);
}
function sanitizeOpenAIResponsesReasoningItemForReplay(item, preserveItemId) {
  const sanitizedItem = { type: "reasoning" };
  if (preserveItemId && typeof item.id === "string")
    sanitizedItem.id = item.id;
  if (Array.isArray(item.summary))
    sanitizedItem.summary = item.summary;
  if (Array.isArray(item.content))
    sanitizedItem.content = item.content;
  if (typeof item.encrypted_content === "string" || item.encrypted_content === null) {
    sanitizedItem.encrypted_content = item.encrypted_content;
  }
  return sanitizedItem;
}
function sanitizeOpenAIResponsesImageGenerationCallForReplay(item) {
  if (typeof item.id !== "string" || typeof item.result !== "string" || item.result.length === 0) {
    return;
  }
  return {
    id: truncateResponseItemId(item.id, "ig"),
    type: "image_generation_call",
    status: "completed",
    result: item.result
  };
}
function getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider) {
  if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
    return;
  }
  const payloadProvider = providerPayload.provider ?? fallbackProvider ?? currentProvider;
  if (payloadProvider !== currentProvider)
    return;
  return { ...providerPayload, provider: payloadProvider };
}
function getOpenAIResponsesHistoryItems(providerPayload, currentProvider, fallbackProvider) {
  return getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider)?.items;
}
// node_modules/@oh-my-pi/pi-utils/src/abortable.ts
import assert from "assert/strict";

class AbortError extends Error {
  constructor(signal) {
    assert(signal.aborted, "Abort signal must be aborted");
    const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
    super(`Aborted: ${message}`, { cause: signal.reason });
    this.name = "AbortError";
  }
}
async function* abortableSource(stream, signal) {
  if (signal?.aborted)
    throw new AbortError(signal);
  const reader = stream.getReader();
  let onAbort;
  if (signal) {
    onAbort = () => {
      reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }
  let completed = false;
  try {
    for (;; ) {
      const result = await reader.read();
      if (signal?.aborted)
        throw new AbortError(signal);
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (signal && onAbort)
      signal.removeEventListener("abort", onAbort);
    if (!completed) {
      try {
        await reader.cancel();
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch {}
  }
}
export {
  abortableSource,
  getOpenAIResponsesHistoryItems,
  sanitizeOpenAIResponsesAssistantHistoryItemsForReplay
};

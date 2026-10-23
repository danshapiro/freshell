// crates/freshell-claude-sidecar/permission-channel.mjs
// Interactive permission/question request-response channel for the claude
// sidecar — a faithful port of the legacy SdkBridge machinery
// (server/sdk-bridge.ts canUseTool :203-214, handlePermissionRequest :516-569,
// handleAskUserQuestion :571-626, respondQuestion :629-648,
// respondPermission :771-783; pending map shapes sdk-bridge-types.ts:113-126).
//
// Pure-ish: state lives on the per-session record; every function takes
// explicit dependencies (emit / nanoid) so the module never imports index.mjs's
// sessions Map or module state. The waiting edge (0 -> >=1 pending) is the
// server's: it folds the request frames and mints the edge itself (C18).

// Lazily attach the two pending maps (sdk-bridge-types.ts:113-126 shapes).
export function ensurePending(session) {
  if (!session.pendingPermissions) session.pendingPermissions = new Map()
  if (!session.pendingQuestions) session.pendingQuestions = new Map()
  return session
}

// Provider-originated cancellation (options.signal; fresh-eyes round-2 F1): on
// abort the pending entry is deleted, the cancelled frame clears the card, and
// the parked promise resolves deny — the query is still open in this state, so
// the resolution is safe (and is NOT a fabricated user approval).
// (Pre-aborted signals are short-circuited by the raises before any parking.)
function subscribeSignal({ signal, clear }) {
  if (signal && !signal.aborted) signal.addEventListener('abort', clear, { once: true })
}

export function raisePermissionRequest({ session, emit, nanoid, sessionId, toolName, input, options }) {
  // Already-aborted provider: nothing to park, no card to raise — deny at once.
  if (options?.signal?.aborted) {
    return Promise.resolve({ behavior: 'deny', message: 'Aborted by provider' })
  }
  ensurePending(session)
  const requestId = nanoid()
  return new Promise((resolve) => {
    session.pendingPermissions.set(requestId, {
      toolName,
      input,
      toolUseID: options?.toolUseID,
      suggestions: options?.suggestions,
      blockedPath: options?.blockedPath,
      decisionReason: options?.decisionReason,
      resolve,
    })
    subscribeSignal({
      signal: options?.signal,
      clear: () => {
        if (!session.pendingPermissions.delete(requestId)) return
        emit({ type: 'sdk.permission.cancelled', sessionId, requestId })
        resolve({ behavior: 'deny', message: 'Aborted by provider' })
      },
    })
    emit({
      type: 'sdk.permission.request',
      sessionId,
      requestId,
      subtype: 'can_use_tool',
      tool: { name: toolName, input },
      toolUseID: options?.toolUseID,
      suggestions: options?.suggestions,
      blockedPath: options?.blockedPath,
      decisionReason: options?.decisionReason,
    })
  })
}

export function raiseQuestionRequest({ session, emit, nanoid, sessionId, input, signal }) {
  ensurePending(session)
  const rawQuestions = input?.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { behavior: 'allow', updatedInput: input }
  }
  const questions = rawQuestions
    .filter((q) => q != null && typeof q === 'object')
    .map((q) => ({
      // Spread first to preserve any extra fields (e.g. SDK-provided IDs).
      ...q,
      // Then override with sanitized known fields.
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      options: Array.isArray(q.options)
        ? q.options
            .filter((o) => o != null && typeof o === 'object')
            .map((o) => ({
              ...o,
              label: String(o.label ?? ''),
              description: String(o.description ?? ''),
            }))
        : [],
      multiSelect: Boolean(q.multiSelect),
    }))
  if (questions.length === 0) {
    return { behavior: 'allow', updatedInput: input }
  }
  // Already-aborted provider: nothing to park, no card to raise — deny at once.
  if (signal?.aborted) {
    return Promise.resolve({ behavior: 'deny', message: 'Aborted by provider' })
  }
  const requestId = nanoid()
  return new Promise((resolve) => {
    session.pendingQuestions.set(requestId, { originalInput: input, questions, resolve })
    subscribeSignal({
      signal,
      clear: () => {
        if (!session.pendingQuestions.delete(requestId)) return
        emit({ type: 'sdk.question.cancelled', sessionId, requestId })
        resolve({ behavior: 'deny', message: 'Aborted by provider' })
      },
    })
    emit({ type: 'sdk.question.request', sessionId, requestId, questions })
  })
}

export function respondPermission(session, requestId, decision) {
  ensurePending(session)
  const pending = session.pendingPermissions.get(requestId)
  if (!pending) return false
  session.pendingPermissions.delete(requestId)
  pending.resolve(decision) // verbatim — never synthesized nor reshaped
  return true
}

export function respondQuestion(session, requestId, answers) {
  ensurePending(session)
  const pending = session.pendingQuestions.get(requestId)
  if (!pending) return false
  session.pendingQuestions.delete(requestId)
  pending.resolve({
    behavior: 'allow',
    updatedInput: {
      ...pending.originalInput,
      questions: pending.questions,
      answers,
    },
  })
  return true
}

// Cancel every parked request: always emit the card-clearing frames. Resolve
// deny ONLY when resolveDeny is true (post-interrupt — the transport is still
// open). Post-close/shutdown callers pass false (LB-04: a late resolve inside
// the SDK's floating promise chain is an unhandled rejection under Node 22
// throw-mode, i.e. a sidecar crash) — a wedged-alive sidecar is unacceptable,
// and a fabricated approval more so; the entry simply never resolves.
export function cancelPending(session, emit, sessionId, { resolveDeny }) {
  ensurePending(session)
  const permissions = [...session.pendingPermissions]
  const questions = [...session.pendingQuestions]
  session.pendingPermissions.clear()
  session.pendingQuestions.clear()
  for (const [requestId, pending] of permissions) {
    emit({ type: 'sdk.permission.cancelled', sessionId, requestId })
    if (resolveDeny) pending.resolve({ behavior: 'deny', message: 'Interrupted' })
  }
  for (const [requestId, pending] of questions) {
    emit({ type: 'sdk.question.cancelled', sessionId, requestId })
    if (resolveDeny) pending.resolve({ behavior: 'deny', message: 'Interrupted' })
  }
}

// canUseTool-shaped adapter (legacy ordering, sdk-bridge.ts:203-214): the
// AskUserQuestion route precedes the bypass fast-path, so a bypass session
// still answers interactive questions.
export function canUseTool({ session, emit, nanoid, sessionId, toolName, input, options }) {
  if (toolName === 'AskUserQuestion') {
    return raiseQuestionRequest({ session, emit, nanoid, sessionId, input, signal: options?.signal })
  }
  if (session.permissionMode === 'bypassPermissions') {
    return { behavior: 'allow', updatedInput: input }
  }
  return raisePermissionRequest({ session, emit, nanoid, sessionId, toolName, input, options })
}

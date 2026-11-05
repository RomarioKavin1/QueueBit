export {
  entryPointAbi,
  frameAccountAbi,
  hotExecuteAbi,
  moduleAbi,
  QUEUE_KINDS,
  roleSignerAbi,
} from "./generated/abi.js";
export type {
  AccountEvent,
  Backend,
  BlockReason,
  EventMeta,
  QueueKind,
  RpcLog,
  WatchedEvent,
  WatchTargets,
} from "./types.js";
export { TargetIndex, blockReasonOf, decodeLog, decodeLogs, decodeRevertName, queueKind } from "./decode.js";
export {
  HOT_EXECUTE_SELECTOR,
  SENDER_MODE,
  blockedFromFrameTx,
  bucketAvailableAt,
  classifyBlocked,
  hotAttempts,
} from "./receipts.js";
export type { BlockEvidence, HotAttempt, MinedFrameReceipt, MinedFrameTx } from "./receipts.js";
export { FOREVER, copyFor, deepLinks, formatDuration } from "./alerts.js";
export type { Alert, AlertKind, AlertRef, CopyInput, Severity, Who } from "./alerts.js";
export { rulesForTransition, rulesForTx, toAlert } from "./rules.js";
export type { AccountRoles, RuleContext, RuleOutput } from "./rules.js";
export { DeadlineTracker } from "./timelock.js";
export type { Deadline, DeadlineKind, Transition } from "./timelock.js";
export { Deduper } from "./dedup.js";
export { WatcherCore, alertId } from "./core.js";
export type { CoreState, WatcherCoreOptions } from "./core.js";
export {
  AUTH_SCHEME,
  DEFAULT_TOLERANCE_S,
  authHeader,
  hmacHex,
  keyBytes,
  parsePairing,
  signAlert,
  signWebhook,
  timingSafeEqualStr,
  verifyAlert,
  verifyAuth,
  verifyWebhook,
} from "./hmac.js";
export type { AuthResult, Pairing, SignedAlert } from "./hmac.js";

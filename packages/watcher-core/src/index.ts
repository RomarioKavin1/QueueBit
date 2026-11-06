export { accountAbi, modulesAbi, MODULE_TYPES } from "./generated/abi.js";
export type { AccountEvent, Backend, EventMeta, PolicyState, RpcLog, WatchedEvent, WatchTargets } from "./types.js";
export { TargetIndex, decodeLog, decodeLogs, decodeRevertName } from "./decode.js";
export { copyFor, deepLinks, formatDuration } from "./alerts.js";
export type { Alert, AlertKind, AlertRef, CopyInput, KeyRole, Severity } from "./alerts.js";
export { capKey, policyLowered, rulesForTransition, rulesForTx, toAlert } from "./rules.js";
export type { RuleContext, RuleOutput, RuleView } from "./rules.js";
export { DeadlineTracker } from "./timelock.js";
export type { Deadline, DeadlineKind, Transition } from "./timelock.js";
export { Deduper } from "./dedup.js";
export { WatcherCore, alertId } from "./core.js";
export type { CoreState, WatcherCoreOptions } from "./core.js";
export {
  AUTH_SCHEME,
  DEFAULT_TOLERANCE_S,
  NonceCache,
  authHeader,
  envelopeMessage,
  hmacHex,
  keyBytes,
  parsePairing,
  randomNonce,
  signAlert,
  signWebhook,
  timingSafeEqualStr,
  verifyAlert,
  verifyAuth,
  verifyWebhook,
  webhookNonce,
} from "./hmac.js";
export type { AuthResult, EnvelopeType, Pairing, SignedAlert } from "./hmac.js";

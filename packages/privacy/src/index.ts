export type * from "./host/types.js";
export {
  EncryptedStorage,
  StorageIntegrityError,
  StorageLockedError,
  chromeStorageBackend,
  importStorageKey,
  memoryBackend,
} from "./host/storage.js";
export type { ChromeStorageAreaLike, EncryptedStorageOptions, StorageBackend } from "./host/storage.js";
export { anonNetwork, directNetwork, freshIsolationKey, isolationKeyFor, networkTransport } from "./host/network.js";
export type { AnonFetch, AnonNetworkOptions, AnonRequestInit } from "./host/network.js";
export { KeystorePathNotAllowedError, VaultKeystore } from "./host/keystore.js";
export type { DelegationResolver } from "./host/keystore.js";
export { createHostProvider, eip1193FromTransport, heliosVerifiedReads } from "./host/provider.js";
export type { Eip1193Like, HostProviderOptions, VerifiedReads } from "./host/provider.js";

export {
  NOTE_DOMAIN_NAME,
  NOTE_DOMAIN_SALT,
  NOTE_DOMAIN_VERSION,
  NOTE_TYPES,
  buildNoteEnvelope,
  canonicalRS,
  deriveNoteSecrets,
  noteEnvelopeDigest,
  noteFieldFromSignature,
  senderKeyFromSignature,
} from "./envelope/envelope.js";
export type { EnvelopeSigner, NoteEnvelope, NoteRef, NoteSecrets } from "./envelope/envelope.js";
export {
  EnvelopeSignatureError,
  QrEnvelopeSigner,
  acceptNoteSignature,
  createNoteSignRequest,
  noteTypedDataJson,
} from "./envelope/qrSigner.js";
export type { NoteSignRequest, QrExchange } from "./envelope/qrSigner.js";
export { NonDeterministicSignerError, createSignatureSecretManager } from "./envelope/secretManager.js";
export type { SecretManager, SignatureSecretManagerOptions } from "./envelope/secretManager.js";

export { ENTRYPOINT_ABI, POOL_ABI, POOL_EVENTS, POOL_PAYER_ABI } from "./pp/abi.js";
export * from "./pp/crypto.js";
export {
  AspIntegrityError,
  SyncIntegrityError,
  applyPoolLogs,
  fetchPoolLogs,
  findRootIndex,
  latestAspRoot,
  poolRootAt,
  staticAsp,
  syncPool,
  verifiedAspLabels,
} from "./pp/sync.js";
export type {
  AspSource,
  DepositEvent,
  FetchLogsOptions,
  PoolState,
  RagequitEvent,
  SyncOptions,
  WithdrawEvent,
} from "./pp/sync.js";
export {
  NoteKeyMismatchError,
  discoverNotes,
  noteFromPublic,
  publicNoteOf,
  refreshPublicNotes,
  spendable,
  unconfirmedDeposit,
} from "./pp/notes.js";
export type { DiscoveryResult, Note, NoteStatus, PublicNote, PublicNoteStatus } from "./pp/notes.js";
export {
  ArtifactHashMismatchError,
  ProofSelfCheckError,
  ProverTimeoutError,
  WITHDRAW_ARTIFACT_PINS,
  createGroth16Prover,
  createWorkerProver,
  fetchArtifactLoader,
  loadPinnedArtifacts,
  serveProver,
  sha256Hex,
  toSolProof,
} from "./pp/prover.js";
export type {
  ArtifactLoader,
  ArtifactName,
  Groth16Backend,
  Groth16Proof,
  PortLike,
  ProveResult,
  Prover,
  SolProof,
  WithdrawArtifacts,
  WithdrawCircuitInputs,
} from "./pp/prover.js";
export {
  COMMITMENT_ARTIFACT_PINS,
  buildRagequitTx,
  createRagequitProver,
  loadPinnedCommitmentArtifacts,
  ragequitInputs,
  toRagequitSolProof,
} from "./pp/ragequit.js";
export type {
  CommitmentArtifactName,
  CommitmentCircuitInputs,
  RagequitProveResult,
  RagequitProver,
  RagequitSolProof,
} from "./pp/ragequit.js";
export { WithdrawalInputError, buildWithdrawInputs } from "./pp/withdraw.js";
export type { WithdrawInputsArgs } from "./pp/withdraw.js";
export {
  DEFAULT_POOL_PAYER_LIMITS,
  MAX_FEE_UINT96,
  MAX_SIGNATURES,
  MAX_UNPRICED_DATA_BYTES,
  VERIFY_DATA_LENGTH,
  PLACEHOLDER_PROOF,
  buildPoolPayerTx,
  checkPoolPayerTx,
  encodeVerifyCall,
  poolPayerWithdrawal,
  readPoolPayerRules,
  refundCall,
  settleCall,
} from "./pp/poolPayer.js";
export type { PoolPayerLimits, PoolPayerRules, PoolPayerTxInit, ShapeContext } from "./pp/poolPayer.js";
export {
  CircuitError,
  DEFAULT_SIDECAR_URL,
  FramePaymasterBroadcaster,
  MempoolOutcomeError,
  PoolPayerShapeError,
  SimulationFailedError,
  localFrameSigner,
  withdrawalClients,
} from "./pp/broadcaster.js";
export type {
  FrameSenderSigner,
  WithdrawalCircuit,
  BuiltFramePaymasterTx,
  FramePaymasterOptions,
  FramePaymasterOutcome,
  FramePaymasterQuote,
} from "./pp/broadcaster.js";
export { RelayerClient, RelayerError, relayerWithdrawal } from "./pp/relayer.js";
export type { RelayerQuote, RelayerResult } from "./pp/relayer.js";
export { PrivacyPoolsV1Client, buildDepositTx } from "./pp/client.js";
export type { DepositTx, PreparedProof, PrivacyPoolsV1Config } from "./pp/client.js";

export {
  FORBIDDEN_FEE_OPTIONS,
  LegalGuardrailError,
  WITHDRAW_MODES,
  assertAtCostFee,
  assertRelayFee,
  assertWithdrawMode,
  rejectFeeOptions,
} from "./guardrails.js";
export type { WithdrawMode } from "./guardrails.js";
export { INVALIDATION_TEXT, classifyInvalidation } from "./ux.js";
export type { InvalidationReason, PrivacyUxState } from "./ux.js";

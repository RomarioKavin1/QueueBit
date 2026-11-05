import { parseAbi, toEventSelector } from "viem";

/**
 * The Privacy Pools v1 ABI parts this client uses, written from the deployed ABI (0xbow `privacy-pools-core`
 * @ df4bf73: `IPrivacyPool`, `IState`, `IEntrypoint`) and from `contracts/src/privacy/PoolPayer.sol`.
 */
export const POOL_ABI = parseAbi([
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
  "event Ragequit(address indexed _ragequitter, uint256 _commitment, uint256 _label, uint256 _value)",
  "event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)",
  "function currentRoot() view returns (uint256)",
  "function currentRootIndex() view returns (uint32)",
  "function currentTreeSize() view returns (uint256)",
  "function roots(uint256 index) view returns (uint256)",
  "function nullifierHashes(uint256 nullifierHash) view returns (bool)",
  "function SCOPE() view returns (uint256)",
  "function ASSET() view returns (address)",
]);

export const POOL_EVENTS = {
  Deposited: toEventSelector(POOL_ABI[0]),
  Withdrawn: toEventSelector(POOL_ABI[1]),
  Ragequit: toEventSelector(POOL_ABI[2]),
  LeafInserted: toEventSelector(POOL_ABI[3]),
} as const;

export const ENTRYPOINT_ABI = parseAbi([
  "function deposit(uint256 _precommitment) payable returns (uint256)",
  "function latestRoot() view returns (uint256)",
  "function scopeToPool(uint256 scope) view returns (address)",
  "function assetConfig(address asset) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)",
  "function usedPrecommitments(uint256 precommitment) view returns (bool)",
  "struct Withdrawal { address processooor; bytes data; }",
  "struct WithdrawProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[8] pubSignals; }",
  "function relay(Withdrawal _withdrawal, WithdrawProof _proof, uint256 _scope)",
]);

export const POOL_PAYER_ABI = parseAbi([
  "struct Withdrawal { address processooor; bytes data; }",
  "struct WithdrawProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[8] pubSignals; }",
  "function verify(uint256 scope, Withdrawal withdrawal, WithdrawProof proof, uint32 rootIndexHint)",
  "function settle(uint8 verifyFrame)",
  "function refund()",
  "function quote(uint256 maxCostWei) pure returns (uint256)",
  "function SCOPE() view returns (uint256)",
  "function POOL() view returns (address)",
  "function ENTRYPOINT() view returns (address)",
  "function FEE_PARAM() view returns (uint8)",
  "function MIN_PAY_STATE_GAS() view returns (uint256)",
  "function MIN_SETTLE_GAS() view returns (uint256)",
  "function MIN_SETTLE_STATE_GAS() view returns (uint256)",
  "function MIN_REFUND_GAS() view returns (uint256)",
  "function MIN_REFUND_STATE_GAS() view returns (uint256)",
  "event Settled(bytes32 indexed sigHash, uint256 indexed nullifierHash, address indexed recipient, uint256 paid, uint256 fee)",
  "event Refunded(bytes32 indexed sigHash, address indexed to, uint256 amount, uint256 costEstimate)",
  "event Credited(address indexed to, uint256 amount)",
]);

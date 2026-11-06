import { parseAbi } from "viem";

/**
 * The LeanAccount stack's ABIs (contracts/src/account), as the SDK calls them. Human-readable fragments keep this file
 * reviewable; test/abi-drift.test.ts checks every fragment against the forge artifacts when contracts/out exists.
 */

const INIT =
  "(address validator, bytes validatorInit, address hook, bytes hookInit, address[] executors, bytes[] executorInits)";
const KEY_INIT =
  "(uint8 kind, uint8 weight, uint8 roles, uint48 validUntil, uint128 perTxCap, bytes32 a, bytes32 b, address[] sessionTargets)";
const KEY = "(uint8 kind, uint8 weight, uint8 roles, uint48 validUntil, uint128 perTxCap, bytes32 a, bytes32 b)";
const POLICY = "(uint16 adminThreshold, uint16 spendThreshold, bool requirePQ, address aggregator)";
const CONFIG =
  "(uint16 adminThreshold, uint16 spendThreshold, bool requirePQ, bool installed, address aggregator, uint16 permAdminWeight, uint16 permSpendWeight, uint16 pqAdminCount)";
const LIMIT = "(uint128 dailyCap, uint64 day, uint128 spent)";

export const leanAccountAbi = parseAbi([
  "function execute(bytes32 mode, bytes executionCalldata) payable",
  "function verify(bytes data) returns (uint8)",
  `function initialize(address validator, bytes validatorInit, address hook, bytes hookInit, address[] executors, bytes[] executorInits)`,
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "function proxiableUUID() view returns (bytes32)",
  "function installModule(uint256 t, address module, bytes initData) payable",
  "function uninstallModule(uint256 t, address module, bytes deInitData) payable",
  "function isModuleInstalled(uint256 t, address module, bytes) view returns (bool)",
  "function accountId() pure returns (string)",
]);

export const factoryAbi = parseAbi([
  `function createAccount(bytes32 salt, ${INIT} init) payable returns (address account)`,
  `function predict(bytes32 salt, ${INIT} init) view returns (address)`,
  "function implementation() view returns (address)",
]);

export const keystoreAbi = parseAbi([
  `function addKey(${KEY_INIT} k)`,
  "function removeKey(bytes32 id)",
  `function rotateKey(bytes32 oldId, ${KEY_INIT} newKey)`,
  "function updateKey(bytes32 id, uint8 weight, uint8 roles, uint48 validUntil, uint128 perTxCap)",
  "function setSessionTargets(bytes32 id, address[] targets, bool allowed)",
  "function setSessionToken(bytes32 id, address token, uint128 perTxCap)",
  `function setPolicy(${POLICY} p)`,
  `function resetKeys(${POLICY} p, ${KEY_INIT}[] keys)`,
  "function pruneExpired(address account, bytes32 id)",
  `function getKey(address account, bytes32 id) view returns (${KEY})`,
  `function getKeys(address account) view returns (bytes32[] ids, ${KEY}[] keys)`,
  `function getConfig(address account) view returns (${CONFIG})`,
  "function isSessionTarget(address account, bytes32 id, address target) view returns (bool)",
  "function sessionTokenCap(address account, bytes32 id, address token) view returns (uint128)",
  "function keyIdOf(uint8 kind, bytes32 a, bytes32 b) pure returns (bytes32)",
  "function hashTypedTx(address account, bytes32 sigHash, (address target, uint256 value, bytes callData)[] calls) view returns (bytes32)",
  "event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 kind, uint8 weight, uint8 roles)",
  "event KeyRemoved(address indexed account, bytes32 indexed keyId)",
  "event KeyUpdated(address indexed account, bytes32 indexed keyId)",
  "event SessionTokenSet(address indexed account, bytes32 indexed keyId, address indexed token, uint128 perTxCap)",
  "event PolicySet(address indexed account, uint16 adminThreshold, uint16 spendThreshold, bool requirePQ, address aggregator)",
]);

export const spendingLimitHookAbi = parseAbi([
  "function setDailyCap(bytes32 keyId, uint128 cap)",
  "function setTokenDailyCap(bytes32 keyId, address token, uint128 cap)",
  `function limitOf(address account, bytes32 keyId) view returns (${LIMIT})`,
  `function tokenLimitOf(address account, bytes32 keyId, address token) view returns (${LIMIT})`,
  "event DailyCapSet(address indexed account, bytes32 indexed keyId, uint128 cap)",
  "event TokenDailyCapSet(address indexed account, bytes32 indexed keyId, address indexed token, uint128 cap)",
  "event SessionSpend(address indexed account, bytes32 indexed keyId, uint256 amount, uint256 spentToday)",
  "event SessionTokenSpend(address indexed account, bytes32 indexed keyId, address indexed token, uint256 amount, uint256 spentToday)",
]);

export const guardianRecoveryAbi = parseAbi([
  "function approve(address account, bytes resetCall)",
  "function execute(address account, bytes resetCall)",
  "function cancel(bytes32 id)",
  "function proposalId(address account, bytes resetCall) view returns (bytes32)",
  "function isGuardian(address guardian, address account) view returns (bool)",
  "event Approved(address indexed account, bytes32 indexed id, address guardian, uint8 approvals, uint64 readyAt)",
  "event Recovered(address indexed account, bytes32 indexed id)",
  "event Cancelled(address indexed account, bytes32 indexed id)",
]);

/** Safe v1.4.1 (the Safe -> LeanAccount migration). */
export const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
]);

export const safeProxyFactoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() pure returns (bytes)",
]);

export const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

/** ERC-1822 / UUPS, read on a migrating smart account's implementation. */
export const proxiableAbi = parseAbi(["function proxiableUUID() view returns (bytes32)"]);

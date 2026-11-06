// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FrameOps, FrameHelperHub} from "./FrameOps.sol";
import {LeanPoolMerkle as MerkleLib} from "../leanpool/LeanPoolMerkle.sol";
import {WebAuthn} from "./WebAuthn.sol";
import {SessionRules} from "./SessionRules.sol";
import {ModuleType, ApprovalMode, ExecMode, Execution, IFrameValidator, IERC7579Execution} from "./interfaces.sol";

interface IRingRegistry {
    function rootAt(address aggregator, address wallet, uint8 i) external view returns (bytes32);
}

interface IModuleAware {
    function isAnyModule(address module) external view returns (bool);
}

/// The LeanPool Account keystore: an ERC-8286 frame validator (module type 11) holding each account's keys and policy.
///
/// Key kinds: PQ (leanVM leanSPHINCS, proven through LeanPool: EIP-8288 triples + a Merkle witness per triple under one
/// root from the account's ring in DepsRegistry), PASSKEY (WebAuthn P256, verified here with P256VERIFY), P256 and
/// ECDSA (protocol-verified signature entries, read through SIGPARAM), and EIP712 (a browser wallet such as MetaMask:
/// EIP-712 typed data `LeanAccountTx(sigHash, calls)` recovered here, so the wallet shows the calls it approves).
/// Only PQ keys are quantum-safe.
///
/// Policy: keys have a weight and roles. An execution that targets the account, this keystore or any installed module
/// is an admin action (adminThreshold of ADMIN weight, and a PQ ADMIN signer when requirePQ is on); any other execution
/// spends (spendThreshold of SPEND weight); a lone SESSION key may spend only to its allowlist, within its per-tx ETH
/// cap and per-tx token caps, and never call a selector that moves assets uncounted (approvals, NFT transfers, permit);
/// daily caps live in SpendingLimitHook, since VERIFY cannot write state.
///
/// Time: VERIFY never reads the clock (ERC-7562 bans TIMESTAMP in validation), so key expiry (`validUntil`) is enforced
/// in execution: SpendingLimitHook asks `executionContext`, which re-runs the decision with expired keys dropped, and
/// reverts the tx if it relied on one. Expiring keys therefore need the hook installed (the factory installs it).
///
/// Storage rule: every slot validateFrame reads is keyed by the account as the innermost mapping key, with fixed-size
/// fields, so it is storage associated with the sender (ERC-7562 STO-021) and an unstaked account passes the alt
/// mempool's storage rule. Arrays and the key list are only read by views.
contract KeystoreValidator is FrameOps, IFrameValidator {
    /// Envelope tag at the head of validator data: LeanPool nodes read the EIP-8288 triples that follow it.
    bytes32 public constant LEANPOOL_DEPS = keccak256("LEANPOOL_DEPS_V1");
    uint256 internal constant LEANSPHINCS_SCHEME = 0x10;
    uint256 internal constant MAX_PQ = 16;
    uint256 internal constant MAX_SIGNERS = 24;
    uint8 internal constant FRAME_MODE_VERIFY = 1;
    uint8 internal constant FRAME_MODE_SENDER = 2;

    uint8 public constant KIND_PQ = 1;
    uint8 public constant KIND_PASSKEY = 2;
    uint8 public constant KIND_P256 = 3;
    uint8 public constant KIND_ECDSA = 4;
    uint8 public constant KIND_EIP712 = 5;
    uint8 public constant ROLE_ADMIN = 1;
    uint8 public constant ROLE_SPEND = 2;
    uint8 public constant ROLE_SESSION = 4;

    struct Key {
        uint8 kind;
        uint8 weight;
        uint8 roles;
        uint48 validUntil; // 0 = permanent
        uint128 perTxCap; // SESSION keys: max ETH value per execution
        bytes32 a; // PQ: vk; PASSKEY: qx; P256/ECDSA: the 20-byte signer address
        bytes32 b; // PASSKEY: qy
    }

    struct KeyInit {
        uint8 kind;
        uint8 weight;
        uint8 roles;
        uint48 validUntil;
        uint128 perTxCap;
        bytes32 a;
        bytes32 b;
        address[] sessionTargets;
    }

    struct Policy {
        uint16 adminThreshold;
        uint16 spendThreshold;
        bool requirePQ;
        address aggregator;
    }

    struct Config {
        uint16 adminThreshold;
        uint16 spendThreshold;
        bool requirePQ;
        bool installed;
        address aggregator;
        uint16 permAdminWeight; // permanent keys only: the safety invariants ignore expiring keys
        uint16 permSpendWeight;
        uint16 pqAdminCount;
    }

    /// Who signed the running transaction, as far as this account's keystore is concerned.
    struct Signers {
        bytes32[MAX_SIGNERS] ids;
        uint256 n;
        uint256 adminWeight;
        uint256 spendWeight;
        bool pqAdmin;
        uint256 sessionCount;
        bytes32 sessionId;
        uint128 sessionCap;
        bool atExecution; // set when re-checking in execution: only then is the clock read (expired keys dropped)
    }

    IRingRegistry public immutable registry;

    mapping(address account => Config) internal _config;
    mapping(bytes32 keyId => mapping(address account => Key)) internal _keys;
    mapping(bytes32 keyId => mapping(address target => mapping(address account => bool))) internal _sessionTargets;
    /// A session key's per-tx cap for one token (0 = the session may not transfer it).
    mapping(bytes32 keyId => mapping(address token => mapping(address account => uint128))) internal _sessionTokens;
    mapping(address account => bytes32[]) internal _keyList; // views and writes only

    bytes32 internal constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 internal constant TX_TYPEHASH =
        keccak256("LeanAccountTx(bytes32 sigHash,Call[] calls)Call(address to,uint256 value,bytes data)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 internal constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 kind, uint8 weight, uint8 roles);
    event KeyRemoved(address indexed account, bytes32 indexed keyId);
    event KeyUpdated(address indexed account, bytes32 indexed keyId);
    event SessionTokenSet(address indexed account, bytes32 indexed keyId, address indexed token, uint128 perTxCap);
    event PolicySet(
        address indexed account, uint16 adminThreshold, uint16 spendThreshold, bool requirePQ, address aggregator
    );

    error NotInstalled();
    error AlreadyInstalled();
    error BadKey();
    error KeyExists(bytes32 keyId);
    error UnknownKey(bytes32 keyId);
    error Invariant(string what);
    error BadEnvelope();
    error BadWitness();
    error NotIncluded(uint256 i);
    error BadPasskey(uint256 entry);
    error TooManySigners();
    error BadTypedSignature(uint256 entry);
    error BadEntry(uint256 entry);
    error NotExpired(bytes32 keyId);

    constructor(IRingRegistry registry_, FrameHelperHub hub) FrameOps(hub) {
        registry = registry_;
    }

    // ------------------------------------------------------------------------------------------ ERC-7579 module ----

    function isModuleType(uint256 t) external pure returns (bool) {
        return t == ModuleType.FRAME_VALIDATOR;
    }

    /// data = abi.encode(Policy, KeyInit[])
    function onInstall(bytes calldata data) external {
        Config storage c = _config[msg.sender];
        if (c.installed) revert AlreadyInstalled();
        (Policy memory p, KeyInit[] memory keys) = abi.decode(data, (Policy, KeyInit[]));
        c.installed = true;
        _setPolicy(msg.sender, p);
        for (uint256 i; i < keys.length; ++i) {
            _addKey(msg.sender, keys[i]);
        }
        _checkInvariants(msg.sender);
    }

    function onUninstall(bytes calldata) external {
        _wipe(msg.sender);
        delete _config[msg.sender];
    }

    // ------------------------------------------------------------------------------------------ ERC-8286 ----------

    /// data = abi.encode(LEANPOOL_DEPS, bytes pqTriples, uint256[] contractEntries): contractEntries index the ARBITRARY
    /// signature entries this keystore verifies itself (passkeys, EIP-712 keys), each abi.encode(bytes32 keyId, ...).
    function validateFrame(bytes calldata data) external view returns (uint8) {
        address account = msg.sender;
        if (address(uint160(_txparam(TX_SENDER))) != account) return ApprovalMode.NONE;
        Config memory c = _config[account];
        if (!c.installed) return ApprovalMode.NONE;
        Signers memory s = _collect(account, c, data, false);
        return _allowed(account, c, s) ? ApprovalMode.EXECUTION_AND_PAYMENT : ApprovalMode.NONE;
    }

    /// For SpendingLimitHook, during the transaction's SENDER frames. VERIFY cannot read the clock (ERC-7562 bans
    /// TIMESTAMP in validation), so it counts keys regardless of `validUntil`; this re-runs the same decision from the
    /// account's VERIFY frame with expired keys dropped. `allowed` false means the tx relied on an expired key and must
    /// not execute. `full`: a full spend or admin quorum signed (not limited by caps); otherwise `sessionKey` is the
    /// single session key that did.
    function executionContext(address account) external view returns (bool allowed, bool full, bytes32 sessionKey) {
        Config memory c = _config[account];
        if (!c.installed) return (true, true, bytes32(0));
        uint256 n = _txparam(TX_FRAME_COUNT);
        for (uint256 f; f < n; ++f) {
            if (_frameparam(f, FP_MODE) != FRAME_MODE_VERIFY) continue;
            if (address(uint160(_frameparam(f, FP_TARGET))) != account) continue;
            bytes memory cd = _framedatacopy(0, _frameparam(f, FP_DATA_LENGTH), f);
            if (cd.length < 4) continue;
            (bytes memory inner) = abi.decode(_tailOf(cd, 4), (bytes)); // verify(bytes data)
            (address validator, bytes memory vdata) = abi.decode(inner, (address, bytes));
            if (validator != address(this)) return (true, true, bytes32(0)); // another validator authorized it
            Signers memory s = this.collectAtExecution(account, vdata);
            allowed = _allowed(account, c, s);
            full =
                s.spendWeight >= c.spendThreshold || (s.adminWeight >= c.adminThreshold && (!c.requirePQ || s.pqAdmin));
            return (allowed, full, s.sessionCount == 1 ? s.sessionId : bytes32(0));
        }
        return (true, true, bytes32(0));
    }

    /// External wrapper so executionContext can decode validator data from memory; reads the clock.
    function collectAtExecution(address account, bytes calldata vdata) external view returns (Signers memory) {
        return _collect(account, _config[account], vdata, true);
    }

    // ------------------------------------------------------------------------------------------ signers -----------

    function _collect(address account, Config memory c, bytes calldata data, bool atExecution)
        internal
        view
        returns (Signers memory s)
    {
        s.atExecution = atExecution;
        (bytes32 tag, bytes memory triples, uint256[] memory contractEntries) =
            abi.decode(data, (bytes32, bytes, uint256[]));
        if (tag != LEANPOOL_DEPS || triples.length % 96 != 0 || triples.length / 96 > MAX_PQ) revert BadEnvelope();
        bytes32 sh = bytes32(_txparam(TX_SIG_HASH));
        uint256 k = triples.length / 96;
        if (k > 0) _collectPQ(account, c, triples, k, sh, s);

        uint256 count = _txparam(TX_SIGNATURE_COUNT);
        for (uint256 j; j < count; ++j) {
            uint256 scheme = _sigparam(j, SP_SCHEME);
            if (scheme != 1 && scheme != 2) continue;
            if (_sigparam(j, SP_MSG) != 0) continue; // only entries over this tx's signature hash
            address signer = address(uint160(_sigparam(j, SP_SIGNER)));
            bytes32 id = keyIdOf(scheme == 1 ? KIND_ECDSA : KIND_P256, bytes32(uint256(uint160(signer))), 0);
            Key memory key = _head(_keys[id][account]);
            if (key.kind != 0) _add(s, id, key);
        }

        // Contract-verified entries (ARBITRARY scheme), each abi.encode(bytes32 keyId, ...): passkeys and EIP-712 keys.
        bytes32 callsHash;
        for (uint256 i; i < contractEntries.length; ++i) {
            uint256 e = contractEntries[i];
            if ((k > 0 && e == 0) || e >= count || _sigparam(e, SP_SCHEME) != 0) revert BadPasskey(e);
            bytes memory d = _sigdatacopy(0, _sigparam(e, SP_LENGTH), e);
            if (d.length < 32) revert BadPasskey(e);
            bytes32 id = bytes32(d);
            Key memory key = _keys[id][account];
            if (key.kind == KIND_PASSKEY) {
                (, WebAuthn.Assertion memory a) = abi.decode(d, (bytes32, WebAuthn.Assertion));
                if (!WebAuthn.verify(sh, a, key.a, key.b)) revert BadPasskey(e);
            } else if (key.kind == KIND_EIP712) {
                if (callsHash == 0) callsHash = _callsHash(account);
                (, bytes memory sig) = abi.decode(d, (bytes32, bytes));
                if (_recover(_typedDigest(account, sh, callsHash), sig) != address(uint160(uint256(key.a)))) {
                    revert BadTypedSignature(e);
                }
            } else {
                revert BadEntry(e);
            }
            _add(s, id, key);
        }
    }

    // ------------------------------------------------------------------------------------------ EIP-712 ----------

    /// What a browser wallet signs: LeanAccountTx(sigHash, calls) under this account's domain.
    function _typedDigest(address account, bytes32 sh, bytes32 callsHash) internal view returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("LeanAccount"), keccak256("1"), block.chainid, account));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(TX_TYPEHASH, sh, callsHash))));
    }

    /// EIP-712 hash of the Call[] that the tx's SENDER frames execute, in order (each frame: account.execute).
    function _callsHash(address account) internal view returns (bytes32) {
        uint256 n = _txparam(TX_FRAME_COUNT);
        bytes memory packed;
        for (uint256 f; f < n; ++f) {
            Execution[] memory xs = _senderExecutions(account, f);
            for (uint256 i; i < xs.length; ++i) {
                packed = abi.encodePacked(packed, _hashCall(xs[i]));
            }
        }
        return keccak256(packed);
    }

    function _hashCall(Execution memory x) internal pure returns (bytes32) {
        return keccak256(abi.encode(CALL_TYPEHASH, x.target, x.value, keccak256(x.callData)));
    }

    /// The digest a browser wallet signs for `calls` (every execution of the tx, in order) and the tx's `sigHash`.
    function hashTypedTx(address account, bytes32 sigHash, Execution[] calldata calls)
        external
        view
        returns (bytes32)
    {
        bytes memory packed;
        for (uint256 i; i < calls.length; ++i) {
            packed = abi.encodePacked(packed, _hashCall(calls[i]));
        }
        return _typedDigest(account, sigHash, keccak256(packed));
    }

    /// 65-byte (r, s, v) signature; low-s only (EIP-2), v 27/28 (or 0/1, as some hardware wallets return). Returns
    /// address(0) when malformed.
    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 sv;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            sv := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        if (uint256(sv) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, sv);
    }

    function _collectPQ(address account, Config memory c, bytes memory triples, uint256 k, bytes32 sh, Signers memory s)
        internal
        view
    {
        if (_sigparam(0, SP_SCHEME) != 0) revert BadWitness();
        bytes memory w = _sigdatacopy(0, _sigparam(0, SP_LENGTH), 0);
        (bytes32 root, uint8 ring, bytes32[][] memory proofs) = abi.decode(w, (bytes32, uint8, bytes32[][]));
        if (proofs.length != k || root == bytes32(0) || ring >= 8) revert BadWitness();
        if (registry.rootAt(c.aggregator, account, ring) != root) revert BadWitness();
        for (uint256 i; i < k; ++i) {
            (uint256 scheme, bytes32 dataHash, bytes32 vk) = _triple(triples, i);
            if (scheme != LEANSPHINCS_SCHEME || dataHash != bytes32(0)) revert BadEnvelope();
            bytes32 id = keyIdOf(KIND_PQ, vk, 0);
            Key memory key = _head(_keys[id][account]);
            if (key.kind != KIND_PQ) revert UnknownKey(id);
            bytes32 leaf = keccak256(abi.encodePacked(LEANSPHINCS_SCHEME, sh, vk));
            if (!MerkleLib.verify(proofs[i], root, leaf)) revert NotIncluded(i);
            _add(s, id, key);
        }
    }

    function _add(Signers memory s, bytes32 id, Key memory key) internal view {
        // The clock only in execution: TIMESTAMP is banned in VERIFY (ERC-7562 OP-011).
        if (s.atExecution && key.validUntil != 0 && block.timestamp > key.validUntil) return;
        for (uint256 i; i < s.n; ++i) {
            if (s.ids[i] == id) return;
        }
        if (s.n == MAX_SIGNERS) revert TooManySigners();
        s.ids[s.n++] = id;
        if (key.roles & ROLE_ADMIN != 0) {
            s.adminWeight += key.weight;
            if (key.kind == KIND_PQ) s.pqAdmin = true;
        }
        if (key.roles & ROLE_SPEND != 0) s.spendWeight += key.weight;
        if (key.roles & ROLE_SESSION != 0) {
            s.sessionCount += 1;
            s.sessionId = id;
            s.sessionCap = key.perTxCap;
        }
    }

    // ------------------------------------------------------------------------------------------ policy ------------

    function _allowed(address account, Config memory c, Signers memory s) internal view returns (bool) {
        bool needAdmin;
        bool anySpend;
        bool sessionOk = s.sessionCount == 1;
        uint256 senders;
        uint256 ethSum; // a session's ETH across the whole tx (the per-tx cap is per tx, not per call)
        // Per-token sums of a session's transfer amounts across the whole tx (checked against the per-tx caps).
        address[] memory tokens = new address[](0);
        uint256[] memory sums = new uint256[](0);
        uint256 n = _txparam(TX_FRAME_COUNT);
        for (uint256 f; f < n; ++f) {
            if (_frameparam(f, FP_MODE) != FRAME_MODE_SENDER) continue;
            senders += 1;
            if (address(uint160(_frameparam(f, FP_TARGET))) != account) return false;
            Execution[] memory xs = _senderExecutions(account, f);
            if (xs.length == 0) return false; // not account.execute
            for (uint256 i; i < xs.length; ++i) {
                if (_isAdminTarget(account, xs[i].target)) {
                    needAdmin = true;
                    continue;
                }
                anySpend = true;
                if (!sessionOk) continue;
                ethSum += xs[i].value;
                if (!_sessionTargets[s.sessionId][xs[i].target][account]) {
                    sessionOk = false;
                    continue;
                }
                bool capped = _sessionTokens[s.sessionId][xs[i].target][account] != 0;
                (bool isTransfer, bool wellFormed, uint256 amount) = SessionRules.transferAmount(xs[i].callData);
                if (capped) {
                    // A capped token: only transfer / transferFrom, counted.
                    if (!isTransfer || !wellFormed) sessionOk = false;
                    else (tokens, sums) = _addSum(tokens, sums, xs[i].target, amount);
                } else if (isTransfer || SessionRules.grantsOrMovesUncounted(xs[i].callData)) {
                    sessionOk = false; // a transfer with no cap to count it against, or a known uncounted move
                }
            }
        }
        if (sessionOk && ethSum > s.sessionCap) sessionOk = false;
        for (uint256 i; sessionOk && i < tokens.length; ++i) {
            if (sums[i] > _sessionTokens[s.sessionId][tokens[i]][account]) sessionOk = false;
        }
        bool adminOk = s.adminWeight >= c.adminThreshold && (!c.requirePQ || s.pqAdmin);
        bool spendOk = s.spendWeight >= c.spendThreshold;
        if (needAdmin && !adminOk) return false;
        if (anySpend && !spendOk && !(sessionOk && !needAdmin)) return false;
        if (senders == 0 && !spendOk && !adminOk) return false; // paying for a tx that does nothing
        return true;
    }

    /// A SENDER frame's executions when it calls account.execute; empty otherwise.
    function _senderExecutions(address account, uint256 f) internal view returns (Execution[] memory xs) {
        if (_frameparam(f, FP_MODE) != FRAME_MODE_SENDER || address(uint160(_frameparam(f, FP_TARGET))) != account) {
            return xs;
        }
        bytes memory cd = _framedatacopy(0, _frameparam(f, FP_DATA_LENGTH), f);
        if (cd.length < 4 || bytes4(cd) != IERC7579Execution.execute.selector) return xs;
        (bytes32 mode, bytes memory ec) = abi.decode(_tailOf(cd, 4), (bytes32, bytes));
        return _executions(mode, ec);
    }

    function _addSum(address[] memory tokens, uint256[] memory sums, address token, uint256 amount)
        internal
        pure
        returns (address[] memory, uint256[] memory)
    {
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == token) {
                sums[i] = sums[i] + amount; // checked: an overflow reverts the validation (the tx is refused)
                return (tokens, sums);
            }
        }
        address[] memory t2 = new address[](tokens.length + 1);
        uint256[] memory s2 = new uint256[](tokens.length + 1);
        for (uint256 i; i < tokens.length; ++i) {
            (t2[i], s2[i]) = (tokens[i], sums[i]);
        }
        (t2[tokens.length], s2[tokens.length]) = (token, amount);
        return (t2, s2);
    }

    function _executions(bytes32 mode, bytes memory ec) internal pure returns (Execution[] memory xs) {
        bytes1 ct = ExecMode.callType(mode);
        if (ct == ExecMode.CALLTYPE_SINGLE) {
            if (ec.length < 52) revert BadEnvelope();
            xs = new Execution[](1);
            address target;
            uint256 value;
            assembly ("memory-safe") {
                target := shr(96, mload(add(ec, 32)))
                value := mload(add(ec, 52))
            }
            xs[0] = Execution(target, value, _tailOf(ec, 52));
        } else if (ct == ExecMode.CALLTYPE_BATCH) {
            xs = abi.decode(ec, (Execution[]));
        } else {
            revert BadEnvelope();
        }
    }

    function _isAdminTarget(address account, address target) internal view returns (bool) {
        return target == account || target == address(this) || IModuleAware(account).isAnyModule(target);
    }

    // ------------------------------------------------------------------------------------------ admin (by account) -

    modifier installed() {
        if (!_config[msg.sender].installed) revert NotInstalled();
        _;
        _checkInvariants(msg.sender);
    }

    function addKey(KeyInit calldata k) external installed {
        _addKey(msg.sender, k);
    }

    function removeKey(bytes32 id) external installed {
        _removeKey(msg.sender, id);
    }

    /// Key rotation in one step: add the new key, remove the old one; invariants are checked after both.
    function rotateKey(bytes32 oldId, KeyInit calldata newKey) external installed {
        _addKey(msg.sender, newKey);
        _removeKey(msg.sender, oldId);
    }

    function updateKey(bytes32 id, uint8 weight, uint8 roles, uint48 validUntil, uint128 perTxCap) external installed {
        Key storage key = _keys[id][msg.sender];
        if (key.kind == 0) revert UnknownKey(id);
        _unaccount(msg.sender, key);
        key.weight = weight;
        key.roles = roles;
        key.validUntil = validUntil;
        key.perTxCap = perTxCap;
        _account(msg.sender, key);
        emit KeyUpdated(msg.sender, id);
    }

    function setSessionTargets(bytes32 id, address[] calldata targets, bool allowed) external installed {
        if (_keys[id][msg.sender].kind == 0) revert UnknownKey(id);
        for (uint256 i; i < targets.length; ++i) {
            _sessionTargets[id][targets[i]][msg.sender] = allowed;
        }
    }

    /// A session key's per-tx cap for transfers of `token` (0 removes it: the session may not move that token).
    function setSessionToken(bytes32 id, address token, uint128 perTxCap) external installed {
        if (_keys[id][msg.sender].kind == 0) revert UnknownKey(id);
        _sessionTokens[id][token][msg.sender] = perTxCap;
        emit SessionTokenSet(msg.sender, id, token, perTxCap);
    }

    /// Anyone may delete a key whose `validUntil` has passed. VERIFY cannot read the clock, so until a key is pruned
    /// it still passes VERIFY (its txs are then stopped in execution by SpendingLimitHook, but the account pays their
    /// fees): wallets and keepers prune expired keys to close that window.
    function pruneExpired(address account, bytes32 id) external {
        Key storage key = _keys[id][account];
        if (key.kind == 0) revert UnknownKey(id);
        if (key.validUntil == 0 || block.timestamp <= key.validUntil) revert NotExpired(id);
        _removeKey(account, id); // expiring keys never count toward the invariants (_account skips them)
    }

    function setPolicy(Policy calldata p) external installed {
        _setPolicy(msg.sender, p);
    }

    /// Replaces every key and the policy (guardian recovery, through the account's executeFromExecutor).
    function resetKeys(Policy calldata p, KeyInit[] calldata keys) external installed {
        _wipe(msg.sender);
        _setPolicy(msg.sender, p);
        for (uint256 i; i < keys.length; ++i) {
            _addKey(msg.sender, keys[i]);
        }
    }

    // ------------------------------------------------------------------------------------------ views -------------

    function keyIdOf(uint8 kind, bytes32 a, bytes32 b) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, a, b));
    }

    function getKey(address account, bytes32 id) external view returns (Key memory) {
        return _keys[id][account];
    }

    function getKeys(address account) external view returns (bytes32[] memory ids, Key[] memory keys) {
        ids = _keyList[account];
        keys = new Key[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            keys[i] = _keys[ids[i]][account];
        }
    }

    function getConfig(address account) external view returns (Config memory) {
        return _config[account];
    }

    function isSessionTarget(address account, bytes32 id, address target) external view returns (bool) {
        return _sessionTargets[id][target][account];
    }

    function sessionTokenCap(address account, bytes32 id, address token) external view returns (uint128) {
        return _sessionTokens[id][token][account];
    }

    // ------------------------------------------------------------------------------------------ internals ---------

    function _addKey(address account, KeyInit memory k) internal {
        if (k.kind < KIND_PQ || k.kind > KIND_EIP712 || k.weight == 0 || k.roles == 0) revert BadKey();
        bool addressKey = k.kind == KIND_P256 || k.kind == KIND_ECDSA || k.kind == KIND_EIP712;
        if (addressKey && (uint256(k.a) >> 160 != 0 || k.a == 0 || k.b != 0)) revert BadKey();
        if (k.kind == KIND_PQ && k.b != 0) revert BadKey();
        bytes32 id = keyIdOf(k.kind, k.a, k.b);
        Key storage key = _keys[id][account];
        if (key.kind != 0) revert KeyExists(id);
        _keys[id][account] = Key(k.kind, k.weight, k.roles, k.validUntil, k.perTxCap, k.a, k.b);
        _account(account, _keys[id][account]);
        _keyList[account].push(id);
        for (uint256 i; i < k.sessionTargets.length; ++i) {
            _sessionTargets[id][k.sessionTargets[i]][account] = true;
        }
        emit KeyAdded(account, id, k.kind, k.weight, k.roles);
    }

    function _removeKey(address account, bytes32 id) internal {
        Key storage key = _keys[id][account];
        if (key.kind == 0) revert UnknownKey(id);
        _unaccount(account, key);
        delete _keys[id][account];
        bytes32[] storage list = _keyList[account];
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == id) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        emit KeyRemoved(account, id);
    }

    function _wipe(address account) internal {
        bytes32[] storage list = _keyList[account];
        for (uint256 i; i < list.length; ++i) {
            delete _keys[list[i]][account];
        }
        delete _keyList[account];
        Config storage c = _config[account];
        c.permAdminWeight = 0;
        c.permSpendWeight = 0;
        c.pqAdminCount = 0;
    }

    function _account(address account, Key storage key) internal {
        if (key.validUntil != 0) return;
        Config storage c = _config[account];
        if (key.roles & ROLE_ADMIN != 0) {
            c.permAdminWeight += key.weight;
            if (key.kind == KIND_PQ) c.pqAdminCount += 1;
        }
        if (key.roles & ROLE_SPEND != 0) c.permSpendWeight += key.weight;
    }

    function _unaccount(address account, Key storage key) internal {
        if (key.validUntil != 0) return;
        Config storage c = _config[account];
        if (key.roles & ROLE_ADMIN != 0) {
            c.permAdminWeight -= key.weight;
            if (key.kind == KIND_PQ) c.pqAdminCount -= 1;
        }
        if (key.roles & ROLE_SPEND != 0) c.permSpendWeight -= key.weight;
    }

    function _setPolicy(address account, Policy memory p) internal {
        Config storage c = _config[account];
        c.adminThreshold = p.adminThreshold;
        c.spendThreshold = p.spendThreshold;
        c.requirePQ = p.requirePQ;
        c.aggregator = p.aggregator;
        emit PolicySet(account, p.adminThreshold, p.spendThreshold, p.requirePQ, p.aggregator);
    }

    function _checkInvariants(address account) internal view {
        Config storage c = _config[account];
        if (c.adminThreshold == 0 || c.spendThreshold == 0) revert Invariant("thresholds must be at least 1");
        if (c.permAdminWeight < c.adminThreshold) revert Invariant("admin keys below the admin threshold");
        if (c.permSpendWeight < c.spendThreshold) revert Invariant("spend keys below the spend threshold");
        if (c.requirePQ && c.pqAdminCount == 0) revert Invariant("requirePQ needs a post-quantum admin key");
    }

    function _triple(bytes memory t, uint256 i) internal pure returns (uint256 scheme, bytes32 dataHash, bytes32 vk) {
        uint256 o = i * 96;
        assembly ("memory-safe") {
            scheme := mload(add(t, add(32, o)))
            dataHash := mload(add(t, add(64, o)))
            vk := mload(add(t, add(96, o)))
        }
    }

    /// A key's first slot only (kind, weight, roles, validUntil, perTxCap): what VERIFY needs for ECDSA, P256 and PQ
    /// signers, whose key material is already bound by the key id.
    function _head(Key storage k) internal view returns (Key memory h) {
        h.kind = k.kind;
        h.weight = k.weight;
        h.roles = k.roles;
        h.validUntil = k.validUntil;
        h.perTxCap = k.perTxCap;
    }
}

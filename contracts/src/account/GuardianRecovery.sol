// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ModuleType, ExecMode, IERC7579Module, IERC7579Execution} from "./interfaces.sol";

interface IKeystoreReset {
    function resetKeys(bytes calldata) external; // selector only: the real signature is resetKeys(Policy, KeyInit[])
}

/// ERC-7579 executor (type 2): guardian recovery. Guardians (any addresses, including other PQ accounts) approve a new
/// keystore configuration: the exact calldata of `KeystoreValidator.resetKeys(policy, keys)`. Once `threshold`
/// guardians approved, it becomes executable after `delay`; anyone may then trigger it, and the account replaces its
/// keys through `executeFromExecutor`. The account cancels a pending recovery with an admin action.
contract GuardianRecovery is IERC7579Module {
    struct Setup {
        bool installed;
        uint8 threshold;
        uint8 guardians;
        uint32 delay;
        uint64 nonce;
        /// Bumped by every install: a guardian belongs to the install that named it, so uninstalling (or reinstalling
        /// with a new set) drops every earlier guardian without having to list them.
        uint64 epoch;
    }

    struct Proposal {
        uint8 approvals;
        uint64 readyAt; // 0 = not enough approvals yet
        bool done;
    }

    address public immutable keystore;
    bytes4 public immutable RESET_SELECTOR;

    mapping(address account => Setup) public setups;
    /// The install epoch that named this guardian (0: never).
    mapping(address guardian => mapping(address account => uint64)) internal guardianEpoch;
    mapping(bytes32 id => mapping(address account => Proposal)) public proposals;
    mapping(bytes32 id => mapping(address guardian => mapping(address account => bool))) public approvedBy;

    event Approved(address indexed account, bytes32 indexed id, address guardian, uint8 approvals, uint64 readyAt);
    event Recovered(address indexed account, bytes32 indexed id);
    event Cancelled(address indexed account, bytes32 indexed id);

    error NotGuardian();
    error AlreadyApproved();
    error NotReady();
    error AlreadyDone();
    error BadCall();
    error BadSetup();

    constructor(address keystore_, bytes4 resetSelector) {
        keystore = keystore_;
        RESET_SELECTOR = resetSelector;
    }

    function isModuleType(uint256 t) external pure returns (bool) {
        return t == ModuleType.EXECUTOR;
    }

    /// data = abi.encode(address[] guardians, uint8 threshold, uint32 delay). Duplicates and the zero address are
    /// skipped; `threshold` must be reachable by the distinct guardians left.
    function onInstall(bytes calldata data) external {
        (address[] memory gs, uint8 threshold, uint32 delay) = abi.decode(data, (address[], uint8, uint32));
        Setup storage s = setups[msg.sender];
        uint64 epoch = s.epoch + 1;
        s.epoch = epoch;
        s.nonce += 1; // no proposal approved under an earlier install survives this one
        s.installed = true;
        s.threshold = threshold;
        s.delay = delay;
        s.guardians = 0;
        for (uint256 i; i < gs.length; ++i) {
            if (gs[i] != address(0) && guardianEpoch[gs[i]][msg.sender] != epoch) {
                guardianEpoch[gs[i]][msg.sender] = epoch;
                s.guardians += 1;
            }
        }
        // Counted after removing duplicates: a threshold above the distinct guardians could never be reached.
        if (threshold == 0 || threshold > s.guardians || delay == 0) revert BadSetup();
    }

    /// True when `guardian` is a guardian of `account`'s current install.
    function isGuardian(address guardian, address account) public view returns (bool) {
        Setup storage s = setups[account];
        return s.installed && guardianEpoch[guardian][account] == s.epoch;
    }

    function onUninstall(bytes calldata) external {
        setups[msg.sender].installed = false;
        setups[msg.sender].nonce += 1; // invalidates every pending proposal
    }

    /// The id guardians approve: bound to the account and its current recovery nonce, so it cannot be replayed.
    function proposalId(address account, bytes calldata resetCall) public view returns (bytes32) {
        return keccak256(abi.encode(account, setups[account].nonce, resetCall));
    }

    function approve(address account, bytes calldata resetCall) external {
        Setup storage s = setups[account];
        if (!isGuardian(msg.sender, account)) revert NotGuardian();
        if (resetCall.length < 4 || bytes4(resetCall[:4]) != RESET_SELECTOR) revert BadCall();
        bytes32 id = proposalId(account, resetCall);
        if (approvedBy[id][msg.sender][account]) revert AlreadyApproved();
        approvedBy[id][msg.sender][account] = true;
        Proposal storage p = proposals[id][account];
        if (p.done) revert AlreadyDone();
        p.approvals += 1;
        if (p.approvals == s.threshold) p.readyAt = uint64(block.timestamp) + s.delay;
        emit Approved(account, id, msg.sender, p.approvals, p.readyAt);
    }

    function execute(address account, bytes calldata resetCall) external {
        bytes32 id = proposalId(account, resetCall);
        Proposal storage p = proposals[id][account];
        if (p.done) revert AlreadyDone();
        if (p.readyAt == 0 || block.timestamp < p.readyAt) revert NotReady();
        p.done = true;
        setups[account].nonce += 1;
        IERC7579Execution(account).executeFromExecutor(
            ExecMode.encode(ExecMode.CALLTYPE_SINGLE, ExecMode.EXECTYPE_DEFAULT),
            abi.encodePacked(keystore, uint256(0), resetCall)
        );
        emit Recovered(account, id);
    }

    /// The account cancels (an admin action: a call to an installed module).
    function cancel(bytes32 id) external {
        Proposal storage p = proposals[id][msg.sender];
        if (p.done) revert AlreadyDone();
        p.done = true;
        emit Cancelled(msg.sender, id);
    }
}

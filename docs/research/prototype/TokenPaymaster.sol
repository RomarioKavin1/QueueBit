// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam, TxParam, FrameParam} from "@forshtat/hegota-support/contracts/Params.sol";

contract MockUSD {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Sender that only approves execution (payment comes from a paymaster).
contract ExecOnlyWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;
    constructor(address owner_) payable { owner = owner_; }
    fallback() external payable {
        require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "bad signer");
        approve(Scope.EXECUTION);
    }
}

/// Token paymaster without Permit2: approves payment only if the tx contains a SENDER frame that pays
/// `fee` of `token` to this paymaster, and the sender's token balance (foreign storage, needs stake) covers it.
contract TokenPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    MockUSD public immutable token;
    uint256 public immutable fee;
    address internal constant REGISTRY = 0xD51c04d7A0B01124E84DE152F4e56d9eeCB22D2F;

    constructor(MockUSD token_, uint256 fee_) payable {
        token = token_;
        fee = fee_;
    }

    function stake() external payable {
        (bool ok, ) = REGISTRY.call{value: msg.value}(abi.encodeWithSignature("addStake(uint32)", uint32(86400)));
        require(ok, "stake failed");
    }

    fallback() external payable {
        address sender = address(uint160(txparam(TxParam.SENDER)));
        uint256 n = txparam(TxParam.FRAME_COUNT);
        bool paid;
        for (uint256 i; i < n; i++) {
            if (frameparam(i, FrameParam.MODE) != 2) continue; // SENDER
            if (frameparam(i, FrameParam.RESOLVED_TARGET) != uint256(uint160(address(token)))) continue;
            bytes32 w0 = framedataload(0, i);
            bytes32 w1 = framedataload(4, i);
            bytes32 w2 = framedataload(36, i);
            if (bytes4(w0) == MockUSD.transfer.selector && address(uint160(uint256(w1))) == address(this) && uint256(w2) >= fee) paid = true;
        }
        require(paid, "no fee frame");
        require(token.balanceOf(sender) >= fee, "insufficient token"); // foreign storage read
        approve(Scope.PAYMENT);
    }
}

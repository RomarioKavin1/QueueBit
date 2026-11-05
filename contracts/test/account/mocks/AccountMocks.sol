// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {LeakedAccountImpl} from "../../../src/account/LeakedAccountImpl.sol";

/// Test fixtures for the account suite (not LEAKED contracts).

contract MockToken is ERC20 {
    uint8 private immutable DEC;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        DEC = d;
    }

    function decimals() public view override returns (uint8) {
        return DEC;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// USDC-style (FiatTokenV2_2) ERC-2612 permit: a contract owner's signature is checked with EIP-1271, so the account
/// can approve a spender with nothing but `isValidSignature(digest, sig)` answering the magic value.
contract PermitToken1271 is ERC20, EIP712 {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    constructor(string memory n) ERC20(n, n) EIP712(n, "2") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function permitDigest(address owner, address spender, uint256 value, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner], deadline)));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature)
        external
    {
        require(block.timestamp <= deadline, "expired");
        require(
            SignatureChecker.isValidSignatureNow(owner, permitDigest(owner, spender, value, deadline), signature),
            "bad sig"
        );
        nonces[owner]++;
        _approve(owner, spender, value);
    }
}

/// USDT-style: `transfer` returns nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
}

/// Returns false instead of reverting.
contract FalseToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// An ERC-20 whose transfer calls back into a target (M-e reentrancy).
contract ReentrantToken is MockToken {
    address public hookTarget;
    bytes public hookData;
    bool public lastOk;
    bytes public lastRet;

    constructor() MockToken("RE", 18) {}

    function setHook(address t, bytes calldata d) external {
        hookTarget = t;
        hookData = d;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (hookTarget != address(0)) {
            (lastOk, lastRet) = hookTarget.call(hookData);
        }
        return super.transfer(to, a);
    }
}

/// A session target: a "router" that pulls approved tokens and sends them to `to`, or takes ETH.
contract MockRouter {
    event Swapped(address token, uint256 amount, address to);

    function pull(IERC20 token, uint256 amount, address to) external payable {
        if (amount != 0) token.transferFrom(msg.sender, to, amount);
        emit Swapped(address(token), amount, to);
    }

    function pullPartial(IERC20 token, uint256 amount, address to) external {
        // leaves part of the approval standing
        token.transferFrom(msg.sender, to, amount / 2);
    }

    function noop() external payable {}

    function fail() external pure {
        revert("router failed");
    }
}

/// Accepts nothing.
contract RejectEth {
    receive() external payable {
        revert("no eth");
    }
}

/// A contract that asks the account for ERC-1271 (stand-in for a dapp / permit verifier).
contract Verifier1271 {
    function check(address account, bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return LeakedAccountImpl(payable(account)).isValidSignature(hash, sig);
    }
}

/// Next implementation for upgrade tests.
contract LeakedAccountImplV2 is LeakedAccountImpl {
    constructor(Devnet d, bool perGas, address roles) LeakedAccountImpl(d, perGas, roles) {}

    function version() external pure returns (uint256) {
        return 2;
    }
}

/// Not UUPS: upgradeToAndCall must reject it.
contract NotUUPS {
    function hello() external pure returns (uint256) {
        return 1;
    }
}

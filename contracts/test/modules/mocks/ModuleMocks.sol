// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPQVerifier} from "../../../src/interfaces/IPQVerifier.sol";

/// Stand-in PQ verifier for policy tests: a "signature" is keccak256(abi.encode(pk, digest)). The real C13 verifier
/// with real signatures is exercised in QueueBitModulesC13.t.sol and the anvil e2e.
contract MockPQVerifier is IPQVerifier {
    function schemeId() external pure returns (bytes32) {
        return keccak256("MOCK-PQ");
    }

    function sigLength() external pure returns (uint256) {
        return 32;
    }

    function verifyGasEstimate() external pure returns (uint256) {
        return 1000;
    }

    function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external pure returns (bool) {
        return sig.length == 32 && bytes32(sig) == keccak256(abi.encode(pk, digest));
    }

    function sign(bytes32 pk, bytes32 digest) external pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encode(pk, digest)));
    }
}

contract MockToken is ERC20 {
    uint8 private immutable DEC;

    constructor(string memory name, uint8 dec) ERC20(name, name) {
        DEC = dec;
    }

    function decimals() public view override returns (uint8) {
        return DEC;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A "router" for session tests: pulls `amount` of `token` from the caller (needs an approval granted in the same
/// batch) and sends it to `to`; or takes ETH.
contract MockRouter {
    function pull(IERC20 token, uint256 amount, address to) external {
        require(token.transferFrom(msg.sender, to, amount), "pull");
    }

    function swapEth(address to) external payable {
        (bool ok,) = to.call{value: msg.value}("");
        require(ok, "eth");
    }

    function noop() external {}
}

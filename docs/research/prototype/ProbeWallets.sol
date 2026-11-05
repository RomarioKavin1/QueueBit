// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// Owner-signed wallet whose VERIFY frame burns gas on demand: VERIFY data = abi.encode(iterations).
/// Used to find the real validation-gas ceiling of each mempool.
contract GasProbeWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;

    constructor(address owner_) payable {
        owner = owner_;
    }

    fallback() external payable {
        require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "bad signer");
        if (msg.data.length >= 32) {
            uint256 n = abi.decode(msg.data, (uint256));
            bytes32 h;
            for (uint256 i; i < n; i++) h = keccak256(abi.encode(h, i));
            assembly { mstore(0x00, h) }
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}

/// Two-tier wallet in miniature: a SECP256K1 entry from `hotKey` approves (the hot path, no cap here),
/// an ARBITRARY entry is verified as a PORST signature over the tx signature hash (the vault path).
contract PorstWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable hotKey;
    address public immutable verifier;

    constructor(address hotKey_, address verifier_) payable {
        hotKey = hotKey_;
        verifier = verifier_;
    }

    fallback() external payable {
        if (sigparam(0, SigParam.SCHEME) == 0) {
            uint256 len = sigparam(0, SigParam.SIGNATURE_LENGTH);
            bytes memory sig = sigdatacopy(0, len, 0);
            bytes32 h = bytes32(txparam(TxParam.SIG_HASH));
            require(IERC1271(verifier).isValidSignature(h, sig) == 0x1626ba7e, "bad pq sig");
        } else {
            require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == hotKey, "bad signer");
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}

/// PORST verified in the execution frame instead of VERIFY (fits the 100k validation cap).
/// VERIFY approves on a SECP256K1 entry (index 1) from `gasKey` and only for a single SENDER frame to self.
/// `vaultSend` then requires a valid PORST signature (ARBITRARY entry, index 0) over the tx signature hash.
contract ExecPorstWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable gasKey;
    address public immutable verifier;

    constructor(address gasKey_, address verifier_) payable {
        gasKey = gasKey_;
        verifier = verifier_;
    }

    fallback() external payable {
        require(address(uint160(sigparam(1, SigParam.RESOLVED_SIGNER))) == gasKey, "bad gas key");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    function vaultSend(address payable to, uint256 amount) external {
        require(msg.sender == address(this), "only self");
        require(sigparam(0, SigParam.SCHEME) == 0, "no pq sig");
        bytes memory sig = sigdatacopy(0, sigparam(0, SigParam.SIGNATURE_LENGTH), 0);
        bytes32 h = bytes32(txparam(TxParam.SIG_HASH));
        require(IERC1271(verifier).isValidSignature(h, sig) == 0x1626ba7e, "bad pq sig");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
    }
}

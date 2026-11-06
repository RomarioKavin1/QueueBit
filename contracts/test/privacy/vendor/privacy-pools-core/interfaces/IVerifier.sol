// SPDX-License-Identifier: Apache-2.0
// Vendored for QueueBit tests from github.com/0xbow-io/privacy-pools-core @ df4bf730214bf9d0c717a9258f7a74861758c269, packages/contracts/src/interfaces/IVerifier.sol (Apache-2.0, see ./LICENSE). Modified: import paths only (made relative). See THIRD_PARTY.md.
pragma solidity 0.8.28;

/**
 * @title IVerifier
 * @notice Interface of the Groth16 verifier contracts
 */
interface IVerifier {
  /**
   * @notice Verifies a Withdrawal Proof
   * @param _pA First elliptic curve point (π_A) of the Groth16 proof, encoded as two field elements
   * @param _pB Second elliptic curve point (π_B) of the Groth16 proof, encoded as 2x2 matrix of field elements
   * @param _pC Third elliptic curve point (π_C) of the Groth16 proof, encoded as two field elements
   * @param _pubSignals The proof public signals (both input and output)
   * @return _valid The boolean indicating if the proof is valid
   */
  function verifyProof(
    uint256[2] memory _pA,
    uint256[2][2] memory _pB,
    uint256[2] memory _pC,
    uint256[8] memory _pubSignals
  ) external returns (bool _valid);

  /**
   * @notice Verifies a Ragequit Proof
   * @param _pA First elliptic curve point (π_A) of the Groth16 proof, encoded as two field elements
   * @param _pB Second elliptic curve point (π_B) of the Groth16 proof, encoded as 2x2 matrix of field elements
   * @param _pC Third elliptic curve point (π_C) of the Groth16 proof, encoded as two field elements
   * @param _pubSignals The proof public signals (both input and output)
   * @return _valid The boolean indicating if the proof is valid
   */
  function verifyProof(
    uint256[2] memory _pA,
    uint256[2][2] memory _pB,
    uint256[2] memory _pC,
    uint256[4] memory _pubSignals
  ) external returns (bool _valid);
}

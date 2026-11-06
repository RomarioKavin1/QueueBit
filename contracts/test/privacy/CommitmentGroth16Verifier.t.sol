// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommitmentGroth16Verifier} from "./CommitmentGroth16Verifier.sol";

/// The devnet pool's ragequit verifier against a real commitment-circuit proof (snarkjs, pinned npm
/// fatsolutions/privacy-pools-core-circuits 1.0.5 artifacts; inputs value 0.1 ETH, label 12345, nullifier 777,
/// secret 888). Public signals: commitmentHash, nullifierHash, value, label.
contract CommitmentGroth16VerifierTest is Test {
    CommitmentGroth16Verifier v;
    uint256[2] pA = [
        uint256(6263092470672671870441815400177717433212899422696688299098918004410363675381),
        10447513287639325058799643245357095263019910542600362573406923367971744117234
    ];
    uint256[2][2] pB = [
        [
            uint256(1267170715654935640947635481467006156600276113287799586637826892345145308859),
            2737142637340009209957786182881632086446910907745956494410169465466449849790
        ],
        [
            uint256(17320641922851145255675416834671495813844655262612937902972766174740576808639),
            5845509289492239038207650303427263906504776710295459728455029721575398790467
        ]
    ];
    uint256[2] pC = [
        uint256(7430034938983650650052079250329615900097108037272567536010453748657114913380),
        11637595827725203885976417230836012357807516717067223322906865983529718049446
    ];
    uint256[4] pub = [
        uint256(8995245600657781839755683413491914112844582530491574304634227569322548850552),
        8314022328977600502360236309892451910870238061452047842843754277126098679161,
        100000000000000000,
        12345
    ];

    function setUp() public {
        v = new CommitmentGroth16Verifier();
    }

    function test_realProofVerifies() public view {
        assertTrue(v.verifyProof(pA, pB, pC, pub));
        assertEq(pub[2], 0.1 ether);
        assertEq(pub[3], 12345);
    }

    function test_tamperedSignalsOrProofFail() public view {
        for (uint256 i; i < 4; i++) {
            uint256[4] memory q = pub;
            q[i] += 1;
            assertFalse(v.verifyProof(pA, pB, pC, q));
        }
        uint256[2] memory a2 = pA;
        a2[0] += 1;
        assertFalse(v.verifyProof(a2, pB, pC, pub));
        uint256[4] memory big = pub;
        big[0] = type(uint256).max;
        assertFalse(v.verifyProof(pA, pB, pC, big));
    }

    function test_withdrawOverloadAlwaysFalse() public view {
        uint256[8] memory w;
        assertFalse(v.verifyProof(pA, pB, pC, w));
    }
}

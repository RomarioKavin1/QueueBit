// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Kernel v3.3 (lib/kernel @ v3.3, MIT), test host only. Kept out of HostArtifacts.sol so that it compiles with the
// project's via-IR pipeline: the legacy pipeline that Safe's file group needs makes it 29,767 B (over EIP-170).
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";

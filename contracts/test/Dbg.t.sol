// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract DbgTest is Test {
    AgentRegistry reg;
    uint256 ctrlPk = 0xBAC0FFEE01;
    uint256 walletPk = 0xBAC0FFEE02;
    address ctrl;
    address w;

    function setUp() public {
        ctrl = vm.addr(ctrlPk);
        w = vm.addr(walletPk);
        vm.warp(1790135286);
        vm.roll(1000);
        reg = new AgentRegistry(makeAddr("a"), makeAddr("v"));
    }

    function test_dbg() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(reg.BIND_WALLET_TYPEHASH(), w, ctrl, dl));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.domainSeparator(), sh));
        emit log_named_bytes32("structHash", sh);
        emit log_named_bytes32("digest", digest);
        emit log_named_address("wallet", w);
        emit log_named_address("ctrl", ctrl);
        emit log_named_uint("dl", dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);
        vm.deal(ctrl, 1 ether);
        vm.prank(ctrl);
        reg.register{value: 0.02 ether}("u", keccak256("e"), keccak256("m"), w, dl, abi.encodePacked(r, s, v));
    }
}

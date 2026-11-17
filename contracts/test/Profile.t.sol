// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QdRaccoonVerifier} from "../src/QdRaccoonVerifier.sol";

library console {
    function log(string memory s, uint256 v) internal view {
        address c = 0x000000000000000000636F6e736F6c652e6c6f67;
        (bool ok,) = c.staticcall(abi.encodeWithSignature("log(string,uint256)", s, v));
        ok;
    }
}

/// Gas profile of the verifier's building blocks (forge test -vv --match-contract Profile).
contract ProfileTest is QdRaccoonVerifier {
    function test_profile() public view {
        uint256 base;
        assembly {
            base := mload(0x40)
            mstore(0x40, add(base, 0x10000))
        }
        uint256 g = gasleft();
        _makeZetas(base);
        console.log("makeZetas", g - gasleft());
        for (uint256 i = 0; i < 512; i++) {
            assembly { mstore(add(add(base, 0x4000), shl(5, i)), mulmod(i, 7919, 33292289)) }
        }
        g = gasleft();
        _nttForward(base + 0x4000, base);
        console.log("nttForward", g - gasleft());
        g = gasleft();
        _nttInverse(base + 0x4000, base);
        console.log("nttInverse", g - gasleft());
    }
}

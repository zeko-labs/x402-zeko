// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {X402BaseUSDCReserveEscrowV4} from "./X402BaseUSDCReserveEscrowV4.sol";

contract X402BaseUSDCReserveEscrowV4Factory is AccessControl {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    address public immutable usdc;

    mapping(bytes32 => address) private _sellerEscrows;

    event SellerEscrowCreated(
        bytes32 indexed sellerIdHash,
        address indexed escrowContract,
        address indexed escrowAdmin,
        address escrowReleaser
    );

    error InvalidFactoryConfig();
    error SellerEscrowAlreadyExists(bytes32 sellerIdHash, address escrowContract);
    error SellerEscrowMissing(bytes32 sellerIdHash);

    constructor(address usdcAddress, address admin, address creator) {
        if (usdcAddress == address(0) || admin == address(0) || creator == address(0)) {
            revert InvalidFactoryConfig();
        }

        usdc = usdcAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CREATOR_ROLE, creator);
    }

    function sellerEscrowOf(bytes32 sellerIdHash) external view returns (address) {
        address escrowContract = _sellerEscrows[sellerIdHash];
        if (escrowContract == address(0)) {
            revert SellerEscrowMissing(sellerIdHash);
        }
        return escrowContract;
    }

    function createSellerEscrow(bytes32 sellerIdHash, address escrowAdmin, address escrowReleaser)
        external
        onlyRole(CREATOR_ROLE)
        returns (address)
    {
        if (sellerIdHash == bytes32(0) || escrowAdmin == address(0) || escrowReleaser == address(0)) {
            revert InvalidFactoryConfig();
        }

        address existing = _sellerEscrows[sellerIdHash];
        if (existing != address(0)) {
            revert SellerEscrowAlreadyExists(sellerIdHash, existing);
        }

        X402BaseUSDCReserveEscrowV4 escrow =
            new X402BaseUSDCReserveEscrowV4(usdc, escrowAdmin, escrowReleaser);
        address escrowContract = address(escrow);
        _sellerEscrows[sellerIdHash] = escrowContract;

        emit SellerEscrowCreated(sellerIdHash, escrowContract, escrowAdmin, escrowReleaser);
        return escrowContract;
    }
}

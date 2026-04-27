// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC3009Token} from "./interfaces/IERC3009Token.sol";

contract X402BaseUSDCReserveEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC3009Token;

    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum ReservationStatus {
        None,
        Reserved,
        Released,
        Refunded
    }

    struct Reservation {
        address payer;
        address payTo;
        uint256 amount;
        uint256 expiry;
        bytes32 resultCommitment;
        ReservationStatus status;
    }

    IERC3009Token public immutable usdc;

    mapping(bytes32 => Reservation) private _reservations;

    event PaymentReserved(
        bytes32 indexed reservationKey,
        bytes32 indexed requestIdHash,
        bytes32 indexed paymentIdHash,
        address payer,
        address payTo,
        uint256 amount,
        bytes32 resultCommitment,
        uint256 expiry
    );

    event PaymentReleased(
        bytes32 indexed reservationKey,
        bytes32 indexed requestIdHash,
        bytes32 indexed paymentIdHash,
        address payTo,
        uint256 amount,
        bytes32 resultCommitment
    );

    event PaymentRefunded(
        bytes32 indexed reservationKey,
        bytes32 indexed requestIdHash,
        bytes32 indexed paymentIdHash,
        address payer,
        uint256 amount
    );

    error InvalidToken(address token);
    error ReservationAlreadyExists(bytes32 reservationKey);
    error ReservationMissing(bytes32 reservationKey);
    error ReservationNotReleasable(bytes32 reservationKey);
    error ReservationNotRefundable(bytes32 reservationKey);
    error ReservationExpired(bytes32 reservationKey, uint256 expiry);
    error ResultCommitmentMismatch(bytes32 reservationKey);
    error InvalidReservationData();

    constructor(address usdcAddress, address admin, address releaser) {
        if (usdcAddress == address(0) || admin == address(0) || releaser == address(0)) {
            revert InvalidReservationData();
        }

        usdc = IERC3009Token(usdcAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELEASER_ROLE, releaser);
        _grantRole(PAUSER_ROLE, admin);
    }

    function reservationKey(bytes32 requestIdHash, bytes32 paymentIdHash) public pure returns (bytes32) {
        return keccak256(abi.encode(requestIdHash, paymentIdHash));
    }

    function reservationOf(bytes32 requestIdHash, bytes32 paymentIdHash) external view returns (Reservation memory) {
        return _reservations[reservationKey(requestIdHash, paymentIdHash)];
    }

    function reserveExactWithAuthorization(
        bytes32 requestIdHash,
        bytes32 paymentIdHash,
        address payer,
        address payTo,
        address token,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes32 resultCommitment,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyRole(RELEASER_ROLE) nonReentrant whenNotPaused {
        if (token != address(usdc)) {
            revert InvalidToken(token);
        }
        if (
            requestIdHash == bytes32(0) ||
            paymentIdHash == bytes32(0) ||
            payer == address(0) ||
            payTo == address(0) ||
            amount == 0 ||
            resultCommitment == bytes32(0) ||
            expiry <= block.timestamp
        ) {
            revert InvalidReservationData();
        }

        bytes32 key = reservationKey(requestIdHash, paymentIdHash);
        if (_reservations[key].status != ReservationStatus.None) {
            revert ReservationAlreadyExists(key);
        }

        usdc.transferWithAuthorization(
            payer,
            address(this),
            amount,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        _reservations[key] = Reservation({
            payer: payer,
            payTo: payTo,
            amount: amount,
            expiry: expiry,
            resultCommitment: resultCommitment,
            status: ReservationStatus.Reserved
        });

        emit PaymentReserved(key, requestIdHash, paymentIdHash, payer, payTo, amount, resultCommitment, expiry);
    }

    function releaseReservedPayment(
        bytes32 requestIdHash,
        bytes32 paymentIdHash,
        bytes32 resultCommitment
    ) external onlyRole(RELEASER_ROLE) nonReentrant whenNotPaused {
        bytes32 key = reservationKey(requestIdHash, paymentIdHash);
        Reservation storage reservation = _reservations[key];

        if (reservation.status == ReservationStatus.None) {
            revert ReservationMissing(key);
        }
        if (reservation.status != ReservationStatus.Reserved) {
            revert ReservationNotReleasable(key);
        }
        if (reservation.resultCommitment != resultCommitment) {
            revert ResultCommitmentMismatch(key);
        }
        if (block.timestamp > reservation.expiry) {
            revert ReservationExpired(key, reservation.expiry);
        }

        reservation.status = ReservationStatus.Released;
        usdc.safeTransfer(reservation.payTo, reservation.amount);

        emit PaymentReleased(
            key,
            requestIdHash,
            paymentIdHash,
            reservation.payTo,
            reservation.amount,
            reservation.resultCommitment
        );
    }

    function refundExpiredPayment(bytes32 requestIdHash, bytes32 paymentIdHash)
        external
        nonReentrant
        whenNotPaused
    {
        bytes32 key = reservationKey(requestIdHash, paymentIdHash);
        Reservation storage reservation = _reservations[key];

        if (reservation.status == ReservationStatus.None) {
            revert ReservationMissing(key);
        }
        if (reservation.status != ReservationStatus.Reserved || block.timestamp < reservation.expiry) {
            revert ReservationNotRefundable(key);
        }

        reservation.status = ReservationStatus.Refunded;
        usdc.safeTransfer(reservation.payer, reservation.amount);

        emit PaymentRefunded(key, requestIdHash, paymentIdHash, reservation.payer, reservation.amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}

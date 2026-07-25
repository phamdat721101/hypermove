// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title DemoInstructionSender
/// @notice SIMPLIFIED, STANDALONE DEMO — NOT the production HyperMoveInstructionSender path.
/// The real contract (../../contracts/InstructionSender.sol) routes through Flare's live
/// TeeExtensionRegistry/TeeMachineRegistry, which requires a real registered TEE machine
/// (blocked in this session — see services/tee-extension/README.md's T1 note). This demo
/// contract reproduces only the event-driven shape of the real flow — emit an instruction
/// event, let an off-chain relay process it, write a result back on-chain — self-contained,
/// with zero dependency on Flare's registry contracts, so the end-to-end mechanics can be
/// demonstrated locally without a live TEE machine or indexer.
contract DemoInstructionSender {
    event InstructionSubmitted(
        uint256 indexed instructionId,
        address indexed sender,
        bytes32 opType,
        bytes32 opCommand,
        bytes message
    );

    event ResultPosted(
        uint256 indexed instructionId,
        bool success,
        bytes data
    );

    struct Result {
        bool posted;
        bool success;
        bytes data;
    }

    uint256 public nextInstructionId = 1;
    mapping(uint256 => Result) public results;

    /// @notice Mirrors HyperMoveInstructionSender's sendGenericAgentTask — emits an event
    /// an off-chain relay watches for, instead of routing through the real TEE registry.
    function sendGenericAgentTask(bytes calldata _message) external payable returns (uint256 instructionId) {
        instructionId = nextInstructionId++;
        emit InstructionSubmitted(
            instructionId,
            msg.sender,
            bytes32("GENERIC_AGENT_TASK"),
            bytes32("COMPUTE"),
            _message
        );
    }

    /// @notice Called by the off-chain relay (this demo's stand-in for extension-tee) once
    /// it has processed the instruction. Anyone can post in this demo — the real contract's
    /// equivalent trust boundary (only a registered TEE machine may post a result) is
    /// exactly the piece that requires live Flare infrastructure this demo intentionally
    /// does not reproduce.
    function postResult(uint256 _instructionId, bool _success, bytes calldata _data) external {
        require(!results[_instructionId].posted, "Result already posted");
        results[_instructionId] = Result(true, _success, _data);
        emit ResultPosted(_instructionId, _success, _data);
    }

    function getResult(uint256 _instructionId) external view returns (bool posted, bool success, bytes memory data) {
        Result memory r = results[_instructionId];
        return (r.posted, r.success, r.data);
    }
}

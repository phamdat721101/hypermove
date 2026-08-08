// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title HyperMoveInstructionSender
/// @author HyperMove (based on the Flare Foundation FCE extension scaffold)
/// @notice On-chain entry point for HyperMove's TEE-proxy extension. Two OPTypes:
/// FINANCIAL_ACTION (SWAP, SETTLE — resolves to a confidential on-chain settlement,
/// stubbed in v1 pending PMW's third-party invocation interface) and
/// GENERIC_AGENT_TASK (COMPUTE — resolves to a confidential computation result,
/// stubbed in v1). See services/tee-extension/README.md and the HyperMove PRD at
/// biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract HyperMoveInstructionSender {
    /// @notice Operation type for financial-action instructions (SWAP, SETTLE).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_FINANCIAL_ACTION = bytes32("FINANCIAL_ACTION");

    /// @notice Command for a confidential swap financial action.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SWAP = bytes32("SWAP");

    /// @notice Command for a confidential settlement financial action.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SETTLE = bytes32("SETTLE");

    /// @notice Operation type for generic confidential agent-task instructions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_GENERIC_AGENT_TASK = bytes32("GENERIC_AGENT_TASK");

    /// @notice Command for a generic confidential compute task.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_COMPUTE = bytes32("COMPUTE");

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice Payload for a FINANCIAL_ACTION instruction.
    struct FinancialActionMessage {
        string action;
        string amount;
        string chain;
    }

    /// @notice Payload for a GENERIC_AGENT_TASK instruction.
    struct GenericAgentTaskMessage {
        string taskType;
        bytes payload;
    }

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Sends a FINANCIAL_ACTION instruction to the TEE.
    /// @param _opCommand One of OP_COMMAND_SWAP / OP_COMMAND_SETTLE.
    /// @param _message ABI-encoded FinancialActionMessage.
    /// @return _instructionId The registry-assigned instruction id, propagated from
    /// TEE_EXTENSION_REGISTRY.sendInstructions() (fixed 2026-08-08 — previously
    /// discarded; callers had no way to poll ext-proxy by the real instruction id
    /// and fell back to using the submission tx hash instead).
    function sendFinancialAction(bytes32 _opCommand, bytes calldata _message) external payable returns (bytes32 _instructionId) {
        require(
            _opCommand == OP_COMMAND_SWAP || _opCommand == OP_COMMAND_SETTLE,
            "Unsupported financial-action opCommand."
        );

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_FINANCIAL_ACTION,
            opCommand: _opCommand,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        _instructionId = TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Sends a GENERIC_AGENT_TASK/COMPUTE instruction to the TEE.
    /// @param _message ABI-encoded GenericAgentTaskMessage.
    /// @return _instructionId The registry-assigned instruction id, propagated from
    /// TEE_EXTENSION_REGISTRY.sendInstructions() (fixed 2026-08-08, same rationale
    /// as sendFinancialAction above).
    function sendGenericAgentTask(bytes calldata _message) external payable returns (bytes32 _instructionId) {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_GENERIC_AGENT_TASK,
            opCommand: OP_COMMAND_COMPUTE,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        _instructionId = TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// @return The extension ID assigned to this contract.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}

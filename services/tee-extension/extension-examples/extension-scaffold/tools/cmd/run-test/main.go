package main

import (
	"flag"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
	"github.com/pkg/errors"
)

// OPCommand hashes for the two financial-action commands (SWAP/SETTLE), matching
// internal/config/config.go and contracts/InstructionSender.sol exactly. teeutils.ToHash
// returns common.Hash, itself a [32]byte, matching the Solidity bytes32 parameter's Go
// binding type.
var opCommandSwap = [32]byte(teeutils.ToHash("SWAP"))
var opCommandSettle = [32]byte(teeutils.ToHash("SETTLE"))

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	flag.Parse()

	instructionSenderAddress := common.HexToAddress(*instructionSenderF)

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Generic: configure contract -----------------------------------------
	logger.Infof("Setting extension ID on instruction sender...")
	err = instrutils.SetExtensionId(testSupport, instructionSenderAddress)
	if err != nil {
		if strings.Contains(err.Error(), "already set") || strings.Contains(err.Error(), "Extension ID already set") {
			logger.Infof("Extension ID already set on contract, continuing")
		} else {
			logger.Errorf("setExtensionId failed: %s", err)
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered? Check that pre-build.sh completed successfully. Error: %s", err))
		}
	}

	// --- Test case 1: Send a FINANCIAL_ACTION/SWAP instruction ---
	// Per this PRD's honest-stub discipline, this instruction is EXPECTED to come back
	// as a structured refusal (Status=0, "not yet implemented — PMW ...") — proving the
	// relay/routing/decode path works end-to-end, without fabricating a settlement result.
	logger.Infof("Sending FINANCIAL_ACTION/SWAP instruction...")

	swapPayload, err := abiEncodeFinancialAction("SWAP", "100", "coston2")
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	swapInstructionId, _, err := instrutils.SendFinancialAction(testSupport, instructionSenderAddress, opCommandSwap, swapPayload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", swapInstructionId.Hex())

	time.Sleep(5 * time.Second)

	err = verifyHonestStubResult(*pf, swapInstructionId, "PMW")
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: FINANCIAL_ACTION/SWAP returned the expected honest not-yet-implemented refusal")

	// --- Test case 2: Send a GENERIC_AGENT_TASK/COMPUTE instruction ---
	logger.Infof("Sending GENERIC_AGENT_TASK/COMPUTE instruction...")

	taskPayload, err := abiEncodeGenericAgentTask("SUMMARIZE", []byte("hello world"))
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	taskInstructionId, _, err := instrutils.SendGenericAgentTask(testSupport, instructionSenderAddress, taskPayload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", taskInstructionId.Hex())

	time.Sleep(5 * time.Second)

	err = verifyHonestStubResult(*pf, taskInstructionId, "not yet implemented")
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: GENERIC_AGENT_TASK/COMPUTE returned the expected honest not-yet-implemented refusal")

	// --- Test case 3: Send a FINANCIAL_ACTION/SETTLE instruction ---
	logger.Infof("Sending FINANCIAL_ACTION/SETTLE instruction...")

	settlePayload, err := abiEncodeFinancialAction("SETTLE", "50", "xrpl-testnet")
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	settleInstructionId, _, err := instrutils.SendFinancialAction(testSupport, instructionSenderAddress, opCommandSettle, settlePayload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", settleInstructionId.Hex())

	time.Sleep(5 * time.Second)

	err = verifyHonestStubResult(*pf, settleInstructionId, "PMW")
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: FINANCIAL_ACTION/SETTLE returned the expected honest not-yet-implemented refusal")

	logger.Infof("All tests passed.")
}

// abiEncodeFinancialAction ABI-encodes the (string action, string amount, string chain)
// tuple matching contracts/InstructionSender.sol's FinancialActionMessage struct.
func abiEncodeFinancialAction(action, amount, chain string) ([]byte, error) {
	tupleTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "action", Type: "string"},
		{Name: "amount", Type: "string"},
		{Name: "chain", Type: "string"},
	})
	if err != nil {
		return nil, err
	}
	args := abi.Arguments{{Type: tupleTy}}
	type fa struct {
		Action string
		Amount string
		Chain  string
	}
	return args.Pack(fa{Action: action, Amount: amount, Chain: chain})
}

// abiEncodeGenericAgentTask ABI-encodes the (string taskType, bytes payload) tuple
// matching contracts/InstructionSender.sol's GenericAgentTaskMessage struct.
func abiEncodeGenericAgentTask(taskType string, payload []byte) ([]byte, error) {
	tupleTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "taskType", Type: "string"},
		{Name: "payload", Type: "bytes"},
	})
	if err != nil {
		return nil, err
	}
	args := abi.Arguments{{Type: tupleTy}}
	type gat struct {
		TaskType string
		Payload  []byte
	}
	return args.Pack(gat{TaskType: taskType, Payload: payload})
}

// verifyHonestStubResult polls the proxy for the given instruction and asserts it
// returned a structured refusal (Status=0) whose Log names the expected blocker —
// never Status=1 (success), which this ship must never produce for these OPTypes.
func verifyHonestStubResult(proxyURL string, instructionId common.Hash, expectedLogSubstring string) error {
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		return err
	}
	actionResult := actionResponse.Result

	if actionResult.Status == 1 {
		return errors.Errorf(
			"instruction unexpectedly SUCCEEDED (Status=1) — this ship must never fabricate " +
				"a financial-action/generic-agent-task result; expected an honest not-yet-implemented refusal",
		)
	}
	if actionResult.Status == 2 {
		return errors.New("instruction still pending after polling, expected a completed refusal")
	}
	if actionResult.Status != 0 {
		return errors.Errorf("unexpected ActionResult.Status: %d", actionResult.Status)
	}

	if !strings.Contains(actionResult.Log, expectedLogSubstring) {
		return errors.Errorf("expected log to contain %q, got %q", expectedLogSubstring, actionResult.Log)
	}
	if !strings.Contains(actionResult.Log, "not yet implemented") {
		return errors.Errorf("expected log to state 'not yet implemented', got %q", actionResult.Log)
	}

	logger.Infof("Honest refusal log: %s", actionResult.Log)
	return nil
}

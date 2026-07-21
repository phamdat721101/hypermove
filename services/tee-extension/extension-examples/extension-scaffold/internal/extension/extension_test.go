package extension

import (
	"encoding/json"
	"net/http"
	"testing"

	"extension-scaffold/internal/config"
	"extension-scaffold/pkg/types"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// toHash mirrors teeutils.ToHash for clarity: left-pads a string into a 32-byte hash.
func toHash(s string) common.Hash { return teeutils.ToHash(s) }

// buildTestAction constructs a teetypes.Action whose Data.Message is the
// JSON-encoded DataFixed payload. This is what processAction expects to parse.
func buildTestAction(opType, opCommand common.Hash, originalMessage []byte) teetypes.Action {
	// DataFixed is the structure that processorutils.Parse extracts from Data.Message.
	type dataFixed struct {
		InstructionID      common.Hash    `json:"instructionId"`
		TeeID              common.Address `json:"teeId"`
		Timestamp          uint64         `json:"timestamp"`
		RewardEpochID      uint32         `json:"rewardEpochId"`
		OPType             common.Hash    `json:"opType"`
		OPCommand          common.Hash    `json:"opCommand"`
		Cosigners          []string       `json:"cosigners"`
		CosignersThreshold uint64         `json:"cosignersThreshold"`
		OriginalMessage    hexutil.Bytes  `json:"originalMessage"`
	}

	df := dataFixed{
		OPType:          opType,
		OPCommand:       opCommand,
		OriginalMessage: originalMessage,
	}
	msg, _ := json.Marshal(df)

	return teetypes.Action{
		Data: teetypes.ActionData{
			ID:            common.HexToHash("0x1234"),
			SubmissionTag: "submit",
			Message:       msg,
		},
	}
}

// abiEncodeFinancialAction produces the ABI-encoded tuple (string action, string amount,
// string chain) matching the Solidity FinancialActionMessage struct.
func abiEncodeFinancialAction(action, amount, chain string) []byte {
	args := abi.Arguments{types.FinancialActionMessageArg}
	type fa struct {
		Action string
		Amount string
		Chain  string
	}
	encoded, _ := args.Pack(fa{Action: action, Amount: amount, Chain: chain})
	return encoded
}

// abiEncodeGenericAgentTask produces the ABI-encoded tuple (string taskType, bytes payload)
// matching the Solidity GenericAgentTaskMessage struct.
func abiEncodeGenericAgentTask(taskType string, payload []byte) []byte {
	args := abi.Arguments{types.GenericAgentTaskMessageArg}
	type gat struct {
		TaskType string
		Payload  []byte
	}
	encoded, _ := args.Pack(gat{TaskType: taskType, Payload: payload})
	return encoded
}

// --- OPType/OPCommand Hash Debug Info ---

func TestProcessAction_UnknownOPType(t *testing.T) {
	e := &Extension{}
	action := buildTestAction(
		toHash("UNKNOWN_TYPE"),
		toHash(config.OPCommandSwap),
		nil,
	)

	status, body := e.processAction(action)

	if status != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, status)
	}

	bodyStr := string(body)
	t.Logf("501 body: %s", bodyStr)

	if !contains(bodyStr, "unsupported op type") {
		t.Error("expected body to contain 'unsupported op type'")
	}

	receivedHash := toHash("UNKNOWN_TYPE").Hex()
	if !contains(bodyStr, receivedHash) {
		t.Errorf("expected body to contain received hash %s", receivedHash)
	}

	if !contains(bodyStr, config.OPTypeFinancialAction) {
		t.Errorf("expected body to contain %q", config.OPTypeFinancialAction)
	}
	if !contains(bodyStr, config.OPTypeGenericAgentTask) {
		t.Errorf("expected body to contain %q", config.OPTypeGenericAgentTask)
	}
}

func TestProcessAction_UnknownOPCommand_FinancialAction(t *testing.T) {
	e := &Extension{}
	action := buildTestAction(
		toHash(config.OPTypeFinancialAction),
		toHash("UNKNOWN_COMMAND"),
		nil,
	)

	status, body := e.processAction(action)

	if status != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, status)
	}

	bodyStr := string(body)
	t.Logf("501 body: %s", bodyStr)

	if !contains(bodyStr, "unsupported op command") {
		t.Error("expected body to contain 'unsupported op command'")
	}

	for _, cmd := range []string{config.OPCommandSwap, config.OPCommandSettle} {
		cmdHash := toHash(cmd).Hex()
		if !contains(bodyStr, cmdHash) {
			t.Errorf("expected body to contain hash for %s: %s", cmd, cmdHash)
		}
		if !contains(bodyStr, cmd) {
			t.Errorf("expected body to contain command name %q", cmd)
		}
	}
}

func TestProcessAction_UnknownOPCommand_GenericAgentTask(t *testing.T) {
	e := &Extension{}
	action := buildTestAction(
		toHash(config.OPTypeGenericAgentTask),
		toHash("UNKNOWN_COMMAND"),
		nil,
	)

	status, body := e.processAction(action)

	if status != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, status)
	}

	bodyStr := string(body)
	if !contains(bodyStr, "unsupported op command") {
		t.Error("expected body to contain 'unsupported op command'")
	}
	if !contains(bodyStr, config.OPCommandCompute) {
		t.Errorf("expected body to contain %q", config.OPCommandCompute)
	}
}

// --- Valid Actions — honest not-yet-implemented stub responses ---

func TestProcessAction_FinancialActionSwap_HonestStub(t *testing.T) {
	e := &Extension{}

	payload := abiEncodeFinancialAction("SWAP", "100", "coston2")
	action := buildTestAction(
		toHash(config.OPTypeFinancialAction),
		toHash(config.OPCommandSwap),
		payload,
	)

	status, body := e.processAction(action)

	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("failed to unmarshal ActionResult: %v", err)
	}

	// This is the load-bearing assertion for the honest-stub discipline: financial-action
	// execution is NOT implemented in this ship, so status must be 0 (error/refusal),
	// never 1 (success) — a fabricated success here would be exactly the failure mode
	// this PRD's pre-mortem (T2) and providers/flare.ts's executeFccConfidential() both
	// guard against.
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 (honest not-yet-implemented refusal), got %d", result.Status)
	}
	if !contains(result.Log, "not yet implemented") {
		t.Errorf("expected log to mention 'not yet implemented', got %q", result.Log)
	}
	if !contains(result.Log, "PMW") {
		t.Errorf("expected log to name the real blocker (PMW), got %q", result.Log)
	}
	// The decode+routing path must still have worked — the decoded amount/chain should
	// appear in the log, proving the request was genuinely parsed, not just rejected blind.
	if !contains(result.Log, "amount=100") || !contains(result.Log, "chain=coston2") {
		t.Errorf("expected log to reflect the decoded request, got %q", result.Log)
	}
	t.Logf("Response log: %s", result.Log)

	if e.financialActionCount != 1 {
		t.Errorf("expected financialActionCount=1, got %d", e.financialActionCount)
	}
}

func TestProcessAction_FinancialActionSettle_HonestStub(t *testing.T) {
	e := &Extension{}

	payload := abiEncodeFinancialAction("SETTLE", "50", "xrpl-testnet")
	action := buildTestAction(
		toHash(config.OPTypeFinancialAction),
		toHash(config.OPCommandSettle),
		payload,
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("failed to unmarshal ActionResult: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 (honest refusal), got %d", result.Status)
	}
}

func TestProcessAction_GenericAgentTaskCompute_HonestStub(t *testing.T) {
	e := &Extension{}

	payload := abiEncodeGenericAgentTask("SUMMARIZE", []byte("hello world"))
	action := buildTestAction(
		toHash(config.OPTypeGenericAgentTask),
		toHash(config.OPCommandCompute),
		payload,
	)

	status, body := e.processAction(action)

	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, status, body)
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("failed to unmarshal ActionResult: %v", err)
	}

	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 (honest not-yet-implemented refusal), got %d", result.Status)
	}
	if !contains(result.Log, "not yet implemented") {
		t.Errorf("expected log to mention 'not yet implemented', got %q", result.Log)
	}
	if !contains(result.Log, "taskType=SUMMARIZE") {
		t.Errorf("expected log to reflect the decoded taskType, got %q", result.Log)
	}
	t.Logf("Response log: %s", result.Log)

	if e.genericTaskCount != 1 {
		t.Errorf("expected genericTaskCount=1, got %d", e.genericTaskCount)
	}
}

// --- Error Cases ---

func TestHandleFinancialAction_EmptyAction(t *testing.T) {
	e := &Extension{}

	payload := abiEncodeFinancialAction("", "100", "coston2")
	action := buildTestAction(
		toHash(config.OPTypeFinancialAction),
		toHash(config.OPCommandSwap),
		payload,
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d (error is in ActionResult, not HTTP), got %d", http.StatusOK, status)
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 (error), got %d", result.Status)
	}
	if !contains(result.Log, "action must not be empty") {
		t.Errorf("expected log to contain 'action must not be empty', got %q", result.Log)
	}
}

func TestHandleFinancialAction_UndecodableMessage(t *testing.T) {
	e := &Extension{}

	action := buildTestAction(
		toHash(config.OPTypeFinancialAction),
		toHash(config.OPCommandSwap),
		[]byte(`not abi-encoded at all`),
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, status)
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 (error), got %d", result.Status)
	}
	if !contains(result.Log, "decoding request") {
		t.Errorf("expected log to mention 'decoding request', got %q", result.Log)
	}
}

func TestHandleGenericAgentTask_EmptyTaskType(t *testing.T) {
	e := &Extension{}

	payload := abiEncodeGenericAgentTask("", []byte("data"))
	action := buildTestAction(
		toHash(config.OPTypeGenericAgentTask),
		toHash(config.OPCommandCompute),
		payload,
	)

	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, status)
	}

	var result teetypes.ActionResult
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("expected ActionResult.Status=0 (error), got %d", result.Status)
	}
	if !contains(result.Log, "taskType must not be empty") {
		t.Errorf("expected log to contain 'taskType must not be empty', got %q", result.Log)
	}
}

// --- State Tracking ---

func TestProcessAction_FinancialActionCountIncrementsAcrossCalls(t *testing.T) {
	e := &Extension{}

	for i := 1; i <= 3; i++ {
		payload := abiEncodeFinancialAction("SWAP", "10", "coston2")
		action := buildTestAction(
			toHash(config.OPTypeFinancialAction),
			toHash(config.OPCommandSwap),
			payload,
		)

		status, _ := e.processAction(action)
		if status != http.StatusOK {
			t.Fatalf("call %d: expected status %d, got %d", i, http.StatusOK, status)
		}

		if e.financialActionCount != i {
			t.Errorf("call %d: expected financialActionCount=%d, got %d", i, i, e.financialActionCount)
		}
	}
}

func TestProcessAction_InvalidDataMessage(t *testing.T) {
	e := &Extension{}

	// Data.Message is not valid JSON — processorutils.Parse should fail
	action := teetypes.Action{
		Data: teetypes.ActionData{
			ID:      common.HexToHash("0xabcd"),
			Message: []byte(`not json at all`),
		},
	}

	status, body := e.processAction(action)

	if status != http.StatusBadRequest {
		t.Fatalf("expected status %d for invalid Data.Message, got %d: %s",
			http.StatusBadRequest, status, body)
	}

	bodyStr := string(body)
	if !contains(bodyStr, "decoding fixed data") {
		t.Errorf("expected body to mention 'decoding fixed data', got %q", bodyStr)
	}
	t.Logf("400 body: %s", bodyStr)
}

// contains is a simple helper to check substring presence.
func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchSubstring(s, substr)
}

func searchSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

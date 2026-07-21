// Package types contains types that could be useful to other apps when interacting with this extension.
package types

import (
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// FinancialActionRequest is the ABI-decoded payload sent via the Solidity contract for
// FINANCIAL_ACTION/SWAP and FINANCIAL_ACTION/SETTLE instructions.
type FinancialActionRequest struct {
	Action string `json:"action"`
	Amount string `json:"amount"`
	Chain  string `json:"chain"`
}

// FinancialActionResponse is the JSON payload returned in ActionResult.Data.
//
// SettlementTxHash is deliberately nullable and unset in this ship: HyperMove's TEE
// extension does not yet perform real Protocol Managed Wallets (PMW) signing — PMW's
// third-party invocation interface is not published as of 2026-07-20 (verified against
// dev.flare.network/fcc/overview). The field is reserved now so a future fast-follow
// that fills it in is additive, not a breaking response-shape change. See
// biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/
// 06-prd-sub-tee-extension-service.md, "Explicit boundary".
type FinancialActionResponse struct {
	Action           string  `json:"action"`
	Status           string  `json:"status"` // always "not_yet_implemented" in this ship
	SettlementTxHash *string `json:"settlementTxHash"`
	ActionCount      int     `json:"actionCount"`
}

// FinancialActionMessageArg describes the ABI layout of FinancialActionMessage from the
// Solidity contract.
var FinancialActionMessageArg abi.Argument

// GenericAgentTaskRequest is the ABI-decoded payload sent via the Solidity contract for
// GENERIC_AGENT_TASK/COMPUTE instructions.
type GenericAgentTaskRequest struct {
	TaskType string `json:"taskType"`
	Payload  []byte `json:"payload"`
}

// GenericAgentTaskResponse is the JSON payload returned in ActionResult.Data.
//
// Result is deliberately unset in this ship — real confidential-compute task execution
// is an honest, tracked fast-follow (see FinancialActionResponse's doc comment for the
// same discipline applied here).
type GenericAgentTaskResponse struct {
	TaskType   string  `json:"taskType"`
	Status     string  `json:"status"` // always "not_yet_implemented" in this ship
	Result     *string `json:"result"`
	TaskCount  int     `json:"taskCount"`
}

// GenericAgentTaskMessageArg describes the ABI layout of GenericAgentTaskMessage from the
// Solidity contract.
var GenericAgentTaskMessageArg abi.Argument

func init() {
	financialTupleTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "action", Type: "string"},
		{Name: "amount", Type: "string"},
		{Name: "chain", Type: "string"},
	})
	FinancialActionMessageArg = abi.Argument{Type: financialTupleTy}

	genericTupleTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "taskType", Type: "string"},
		{Name: "payload", Type: "bytes"},
	})
	GenericAgentTaskMessageArg = abi.Argument{Type: genericTupleTy}
}

// State holds the extension's observable state, returned by GET /state.
type State struct {
	FinancialActionCount int    `json:"financialActionCount"`
	LastFinancialAction  string `json:"lastFinancialAction"`
	GenericTaskCount     int    `json:"genericTaskCount"`
	LastGenericTask      string `json:"lastGenericTask"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}

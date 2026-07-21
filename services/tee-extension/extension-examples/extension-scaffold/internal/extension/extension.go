package extension

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"extension-scaffold/internal/config"
	"extension-scaffold/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"
)

type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	financialActionCount int
	lastFinancialAction  string
	genericTaskCount     int
	lastGenericTask      string
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// stateHandler() structure is boilerplate but update the State field mapping to match your Extension fields.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			FinancialActionCount: e.financialActionCount,
			LastFinancialAction:  e.lastFinancialAction,
			GenericTaskCount:     e.genericTaskCount,
			LastGenericTask:      e.lastGenericTask,
		},
	}
	e.mu.RUnlock()

	err := json.NewEncoder(w).Encode(stateResponse)
	if err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeFinancialAction):
		return e.processFinancialAction(action, dataFixed)

	case dataFixed.OPType == teeutils.ToHash(config.OPTypeGenericAgentTask):
		return e.processGenericAgentTask(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s) or %s (%s)",
			dataFixed.OPType.Hex(),
			teeutils.ToHash(config.OPTypeFinancialAction).Hex(), config.OPTypeFinancialAction,
			teeutils.ToHash(config.OPTypeGenericAgentTask).Hex(), config.OPTypeGenericAgentTask,
		))
	}
}

// processFinancialAction routes FINANCIAL_ACTION instructions by OPCommand (SWAP, SETTLE).
func (e *Extension) processFinancialAction(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandSwap):
		ar := e.handleFinancialAction(action, df, "SWAP")
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	case df.OPCommand == teeutils.ToHash(config.OPCommandSettle):
		ar := e.handleFinancialAction(action, df, "SETTLE")
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandSwap).Hex(), config.OPCommandSwap,
			teeutils.ToHash(config.OPCommandSettle).Hex(), config.OPCommandSettle,
		))
	}
}

// handleFinancialAction decodes a FinancialActionRequest and returns an HONEST
// not-yet-implemented result. Real Protocol Managed Wallets (PMW) signing — the
// mechanism that would produce a genuine on-chain settlement transaction — is not
// implemented here because PMW's third-party invocation interface is not published
// as of 2026-07-20 (verified against dev.flare.network/fcc/overview during this PRD's
// research). Building against a guessed ABI would risk a wrong on-chain call, which
// this codebase's own conventions (see providers/flare.ts's executeFccConfidential())
// treat as strictly worse than an honest refusal. This function decodes the request
// and returns a well-formed, schema-stable FAILURE result (status 0) — the routing and
// decode path IS real and tested; the settlement logic is the tracked fast-follow.
func (e *Extension) handleFinancialAction(action teetypes.Action, df *instruction.DataFixed, opCommand string) teetypes.ActionResult {
	var req types.FinancialActionRequest
	err := structs.DecodeTo(types.FinancialActionMessageArg, df.OriginalMessage, &req)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}

	if req.Action == "" {
		return buildResult(action, df, nil, 0, fmt.Errorf("action must not be empty"))
	}

	e.mu.Lock()
	e.financialActionCount++
	e.lastFinancialAction = fmt.Sprintf("%s %s on %s", opCommand, req.Amount, req.Chain)
	e.mu.Unlock()

	return buildResult(action, df, nil, 0, fmt.Errorf(
		"financial-action execution not yet implemented — PMW third-party invocation "+
			"interface not published as of 2026-07-20; see dev.flare.network/fcc/overview "+
			"for updates. Decoded request: action=%s amount=%s chain=%s",
		req.Action, req.Amount, req.Chain,
	))
}

// processGenericAgentTask handles GENERIC_AGENT_TASK/COMPUTE instructions.
func (e *Extension) processGenericAgentTask(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandCompute):
		ar := e.handleGenericAgentTask(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected %s (%s)",
			df.OPCommand.Hex(), teeutils.ToHash(config.OPCommandCompute).Hex(), config.OPCommandCompute,
		))
	}
}

// handleGenericAgentTask decodes a GenericAgentTaskRequest and returns an HONEST
// not-yet-implemented result. Same discipline as handleFinancialAction: the routing
// and decode path is real and tested; the actual confidential-compute task logic is
// the tracked fast-follow (per the user's own "do it later" scoping decision for this
// PRD — see 06-prd-sub-tee-extension-service.md's "Explicit boundary" section).
func (e *Extension) handleGenericAgentTask(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.GenericAgentTaskRequest
	err := structs.DecodeTo(types.GenericAgentTaskMessageArg, df.OriginalMessage, &req)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}

	if req.TaskType == "" {
		return buildResult(action, df, nil, 0, fmt.Errorf("taskType must not be empty"))
	}

	e.mu.Lock()
	e.genericTaskCount++
	e.lastGenericTask = req.TaskType
	e.mu.Unlock()

	return buildResult(action, df, nil, 0, fmt.Errorf(
		"generic-agent-task execution not yet implemented in this ship — interface and "+
			"OPCommand routing are real and tested; task logic is the tracked fast-follow. "+
			"Decoded request: taskType=%s payloadBytes=%d",
		req.TaskType, len(req.Payload),
	))
}


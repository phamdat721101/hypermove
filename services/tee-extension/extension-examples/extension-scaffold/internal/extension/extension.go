package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

	"extension-scaffold/internal/config"
	"extension-scaffold/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/attestation"
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

// handleGenericAgentTask decodes a GenericAgentTaskRequest and dispatches by
// taskType. "dream.extract" (Task 2, 2026-08-08, Dream Cycle Confidential
// Extraction on Flare FCC) calls out to HyperMove's already-deployed
// llm-service /dream/extract route and returns REAL extraction output —
// every other taskType still returns the honest not-yet-implemented refusal
// unchanged from before.
//
// Scope boundary (documented per this feature's own explicit decision,
// 2026-08-08): this ships "TEE-attested dispatch + result signing," NOT "the
// LLM call itself runs inside the TEE" — the actual token generation still
// happens in the existing non-TEE services/llm process, reached over the
// network exactly like any other external HTTP call this extension makes.
// Duplicating Bedrock/DeepSeek calls natively in Go here was explicitly
// rejected in favor of reusing the already-built, already-tested prompt/
// parsing logic in one place. Do not read AttestationQuote below as "this
// proves the LLM call was confidential" — it does not.
//
// Attestation quote: under SIMULATED_TEE=true (the only mode this ship
// targets — no GCP Confidential VM hardware requested), the real Google
// Confidential Space attestation flow is unavailable, so this returns
// tee-node/pkg/attestation.MagicPass verbatim — a real, public, documented
// "testing outside of the google cloud" sentinel constant, NEVER a
// fabricated-but-plausible-looking fake quote hex. confidential.ts's
// verifyAttestation() (a real Phala Cloud API call) will correctly, honestly
// REJECT this value as a malformed quote — that is the expected, correct
// outcome for this dev deployment, not a bug to work around. Real hardware
// hosting (SIMULATED_TEE=false) is required before this can ever pass real
// attestation verification.
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
	taskCount := e.genericTaskCount
	e.mu.Unlock()

	if req.TaskType != "dream.extract" {
		return buildResult(action, df, nil, 0, fmt.Errorf(
			"generic-agent-task execution not yet implemented for taskType=%s — only "+
				"\"dream.extract\" is implemented in this ship. Decoded request: taskType=%s payloadBytes=%d",
			req.TaskType, req.TaskType, len(req.Payload),
		))
	}

	insights, extractErr := callDreamExtract(string(req.Payload))
	if extractErr != nil {
		resp := types.GenericAgentTaskResponse{
			TaskType:  req.TaskType,
			Status:    "extract_failed",
			TaskCount: taskCount,
		}
		b, _ := json.Marshal(resp)
		// Honest failure: non-2xx / timeout / malformed /dream/extract response
		// -> ActionResult.Status = 0, never a fabricated success. Mirrors
		// extract.ts's own extractOneCluster() fail-safe discipline on the TS
		// side (empty-but-well-formed result, never a crash, never fabricated).
		return buildResult(action, df, b, 0, fmt.Errorf("dream.extract call failed: %w", extractErr))
	}

	resp := types.GenericAgentTaskResponse{
		TaskType:         req.TaskType,
		Status:           "ok",
		TaskCount:        taskCount,
		AttestationQuote: string(attestation.MagicPass),
		Insights:         insights,
	}
	b, marshalErr := json.Marshal(resp)
	if marshalErr != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("marshaling response: %w", marshalErr))
	}
	return buildResult(action, df, b, 1, nil)
}

// callDreamExtract POSTs to config.DreamExtractURL (services/llm's
// /dream/extract route) and returns the genuine extraction result. Fails
// honestly (non-nil error, nil insights) on any non-2xx status, network
// error, timeout, or a response carrying extraction_failure_reason (mirrors
// extract.ts's own "genuine" tagging on the TS side — a services/llm
// fail-safe empty stub must never be reported as real insights here either).
func callDreamExtract(summary string) (*types.DreamInsights, error) {
	reqBody, err := json.Marshal(types.DreamExtractRequest{
		Summary:         summary,
		MaxOutputTokens: 300,
	})
	if err != nil {
		return nil, fmt.Errorf("encoding request: %w", err)
	}

	client := &http.Client{Timeout: config.DreamExtractTimeout}
	httpReq, err := http.NewRequest(http.MethodPost, config.DreamExtractURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	httpReq.Header.Set("content-type", "application/json")

	res, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling %s: %w", config.DreamExtractURL, err)
	}
	defer res.Body.Close() //nolint:errcheck

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("extract endpoint returned %d: %s", res.StatusCode, string(body))
	}

	var parsed types.DreamExtractResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}

	if parsed.ExtractionFailureReason != "" {
		return nil, fmt.Errorf("extraction not genuine: %s", parsed.ExtractionFailureReason)
	}

	return &types.DreamInsights{
		Rules:         truncate(parsed.Rules, 10),
		Preferences:   truncate(parsed.Preferences, 10),
		ErrorPatterns: truncate(parsed.ErrorPatterns, 10),
		Facts:         truncate(parsed.Facts, 10),
	}, nil
}

func truncate(s []string, max int) []string {
	if s == nil {
		return []string{}
	}
	if len(s) <= max {
		return s
	}
	return s[:max]
}


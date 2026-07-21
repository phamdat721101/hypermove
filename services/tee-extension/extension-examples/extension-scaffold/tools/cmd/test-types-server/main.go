package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"

	"extension-scaffold/pkg/types"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
)

type decodeRequest struct {
	OPType    string `json:"opType"`
	OPCommand string `json:"opCommand"`
	Kind      string `json:"kind"`
	Data      string `json:"data"`
}

func main() {
	tf := flag.String("t", "http://localhost:8100", "types server URL")
	flag.Parse()

	baseURL := *tf

	passed := 0
	failed := 0

	run := func(name string, fn func() error) {
		logger.Infof("TEST: %s", name)
		if err := fn(); err != nil {
			logger.Errorf("  FAIL: %s", err)
			failed++
		} else {
			logger.Infof("  PASS")
			passed++
		}
	}

	// --- Success cases ---

	run("FINANCIAL_ACTION/SWAP message (ABI-encoded)", func() error {
		req := types.FinancialActionRequest{Action: "SWAP", Amount: "100", Chain: "coston2"}
		encoded, err := structs.Encode(types.FinancialActionMessageArg, req)
		if err != nil {
			return fmt.Errorf("ABI encode: %w", err)
		}
		data := hexutil.Encode(encoded)
		resp, err := postDecode(baseURL, decodeRequest{
			OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: "message", Data: data,
		})
		if err != nil {
			return err
		}
		if err := requireField(resp, "action", "SWAP"); err != nil {
			return err
		}
		if err := requireField(resp, "amount", "100"); err != nil {
			return err
		}
		return requireField(resp, "chain", "coston2")
	})

	run("FINANCIAL_ACTION/SWAP result (JSON)", func() error {
		payload, _ := json.Marshal(map[string]any{
			"action": "SWAP", "status": "not_yet_implemented", "settlementTxHash": nil, "actionCount": 1,
		})
		data := hexutil.Encode(payload)
		resp, err := postDecode(baseURL, decodeRequest{
			OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: "result", Data: data,
		})
		if err != nil {
			return err
		}
		if err := requireField(resp, "status", "not_yet_implemented"); err != nil {
			return err
		}
		return requireFieldFloat(resp, "actionCount", 1)
	})

	run("FINANCIAL_ACTION/SETTLE message (ABI-encoded)", func() error {
		req := types.FinancialActionRequest{Action: "SETTLE", Amount: "50", Chain: "xrpl-testnet"}
		encoded, err := structs.Encode(types.FinancialActionMessageArg, req)
		if err != nil {
			return fmt.Errorf("ABI encode: %w", err)
		}
		data := hexutil.Encode(encoded)
		resp, err := postDecode(baseURL, decodeRequest{
			OPType: "FINANCIAL_ACTION", OPCommand: "SETTLE", Kind: "message", Data: data,
		})
		if err != nil {
			return err
		}
		if err := requireField(resp, "action", "SETTLE"); err != nil {
			return err
		}
		return requireField(resp, "chain", "xrpl-testnet")
	})

	run("GENERIC_AGENT_TASK/COMPUTE message (ABI-encoded)", func() error {
		req := types.GenericAgentTaskRequest{TaskType: "SUMMARIZE", Payload: []byte("hello world")}
		encoded, err := structs.Encode(types.GenericAgentTaskMessageArg, req)
		if err != nil {
			return fmt.Errorf("ABI encode: %w", err)
		}
		data := hexutil.Encode(encoded)
		resp, err := postDecode(baseURL, decodeRequest{
			OPType: "GENERIC_AGENT_TASK", OPCommand: "COMPUTE", Kind: "message", Data: data,
		})
		if err != nil {
			return err
		}
		return requireField(resp, "taskType", "SUMMARIZE")
	})

	run("GENERIC_AGENT_TASK/COMPUTE result (JSON)", func() error {
		payload, _ := json.Marshal(map[string]any{
			"taskType": "SUMMARIZE", "status": "not_yet_implemented", "result": nil, "taskCount": 1,
		})
		data := hexutil.Encode(payload)
		resp, err := postDecode(baseURL, decodeRequest{
			OPType: "GENERIC_AGENT_TASK", OPCommand: "COMPUTE", Kind: "result", Data: data,
		})
		if err != nil {
			return err
		}
		return requireField(resp, "status", "not_yet_implemented")
	})

	// --- Error cases ---

	run("unknown OPType → 404", func() error {
		return expectStatus(baseURL, decodeRequest{
			OPType: "UNKNOWN", OPCommand: "", Kind: "message", Data: "0x7b7d",
		}, http.StatusNotFound)
	})

	run("invalid kind → 400", func() error {
		return expectStatus(baseURL, decodeRequest{
			OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: "invalid", Data: "0x7b7d",
		}, http.StatusBadRequest)
	})

	run("invalid hex → 400", func() error {
		return expectStatus(baseURL, decodeRequest{
			OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: "message", Data: "not-hex",
		}, http.StatusBadRequest)
	})

	run("valid hex, bad payload → 422", func() error {
		return expectStatus(baseURL, decodeRequest{
			OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: "message", Data: "0xdeadbeef",
		}, http.StatusUnprocessableEntity)
	})

	// --- Summary ---
	logger.Infof("")
	logger.Infof("Results: %d passed, %d failed", passed, failed)
	if failed > 0 {
		os.Exit(1)
	}
}

// postDecode sends a POST /decode request and returns the "decoded" field from the response.
func postDecode(baseURL string, req decodeRequest) (map[string]any, error) {
	body, _ := json.Marshal(req)
	resp, err := http.Post(baseURL+"/decode", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("POST /decode: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("expected 200, got %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Decoded map[string]any `json:"decoded"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}

	return result.Decoded, nil
}

// expectStatus sends a POST /decode and asserts the HTTP status code.
func expectStatus(baseURL string, req decodeRequest, wantStatus int) error {
	body, _ := json.Marshal(req)
	resp, err := http.Post(baseURL+"/decode", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("POST /decode: %w", err)
	}
	defer resp.Body.Close()
	io.ReadAll(resp.Body) //nolint:errcheck

	if resp.StatusCode != wantStatus {
		return fmt.Errorf("expected status %d, got %d", wantStatus, resp.StatusCode)
	}
	return nil
}

// requireField asserts a string field in the decoded response.
func requireField(decoded map[string]any, key, want string) error {
	got, ok := decoded[key]
	if !ok {
		return fmt.Errorf("missing field %q", key)
	}
	gotStr, ok := got.(string)
	if !ok {
		return fmt.Errorf("field %q: expected string, got %T", key, got)
	}
	if gotStr != want {
		return fmt.Errorf("field %q: expected %q, got %q", key, want, gotStr)
	}
	return nil
}

// requireFieldFloat asserts a numeric field in the decoded response.
func requireFieldFloat(decoded map[string]any, key string, want float64) error {
	got, ok := decoded[key]
	if !ok {
		return fmt.Errorf("missing field %q", key)
	}
	gotFloat, ok := got.(float64)
	if !ok {
		return fmt.Errorf("field %q: expected number, got %T", key, got)
	}
	if gotFloat != want {
		return fmt.Errorf("field %q: expected %v, got %v", key, want, gotFloat)
	}
	return nil
}

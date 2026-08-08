// Package config contains configuration values and defaults used by the extension.
package config

import (
	"os"
	"strconv"
	"time"
)

const (
	Version = "0.1.0"

	OPTypeFinancialAction  = "FINANCIAL_ACTION"
	OPCommandSwap          = "SWAP"
	OPCommandSettle        = "SETTLE"

	OPTypeGenericAgentTask = "GENERIC_AGENT_TASK"
	OPCommandCompute       = "COMPUTE"

	TimeoutShutdown = 5 * time.Second
)

// Defaults.
var (
	ExtensionPort  = 8080
	SignPort       = 9090
	TypesServerPort = 8100
)

// Environment variables override defaults.
func init() {
	ep := os.Getenv("EXTENSION_PORT")
	sp := os.Getenv("SIGN_PORT")
	tp := os.Getenv("TYPES_SERVER_PORT")

	if ep != "" {
		if v, err := strconv.Atoi(ep); err == nil {
			ExtensionPort = v
		}
	}
	if sp != "" {
		if v, err := strconv.Atoi(sp); err == nil {
			SignPort = v
		}
	}
	if tp != "" {
		if v, err := strconv.Atoi(tp); err == nil {
			TypesServerPort = v
		}
	}

	if v := os.Getenv("DREAM_EXTRACT_URL"); v != "" {
		DreamExtractURL = v
	}
}

// DreamExtractURL points at HyperMove's llm-service /dream/extract route
// (services/llm/server.ts). Default matches the real deployed VPS route
// (Task 2, 2026-08-08) — override via DREAM_EXTRACT_URL for local dev.
var DreamExtractURL = "https://hypermove.duckdns.org/llm/dream/extract"

// DreamExtractTimeout bounds the HTTP call to services/llm — an unreachable
// or slow extraction service must fail honestly rather than hang the whole
// TEE action pipeline indefinitely.
const DreamExtractTimeout = 20 * time.Second

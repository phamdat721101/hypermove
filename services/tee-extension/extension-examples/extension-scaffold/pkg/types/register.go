package types

import "extension-scaffold/pkg/decoder"

// RegisterDecoders registers all type decoders for this extension.
// Extension developers: add new registrations here for each OPType/OPCommand.
func RegisterDecoders(r *decoder.Registry) {
	// FINANCIAL_ACTION/SWAP message (ABI-encoded) + result (JSON)
	r.Register(
		decoder.RegistryKey{OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: decoder.KindMessage},
		decoder.NewABIDecoder[FinancialActionRequest](FinancialActionMessageArg),
	)
	r.Register(
		decoder.RegistryKey{OPType: "FINANCIAL_ACTION", OPCommand: "SWAP", Kind: decoder.KindResult},
		decoder.NewJSONDecoder[FinancialActionResponse](),
	)
	// FINANCIAL_ACTION/SETTLE message (ABI-encoded) + result (JSON)
	r.Register(
		decoder.RegistryKey{OPType: "FINANCIAL_ACTION", OPCommand: "SETTLE", Kind: decoder.KindMessage},
		decoder.NewABIDecoder[FinancialActionRequest](FinancialActionMessageArg),
	)
	r.Register(
		decoder.RegistryKey{OPType: "FINANCIAL_ACTION", OPCommand: "SETTLE", Kind: decoder.KindResult},
		decoder.NewJSONDecoder[FinancialActionResponse](),
	)
	// GENERIC_AGENT_TASK/COMPUTE message (ABI-encoded) + result (JSON)
	r.Register(
		decoder.RegistryKey{OPType: "GENERIC_AGENT_TASK", OPCommand: "COMPUTE", Kind: decoder.KindMessage},
		decoder.NewABIDecoder[GenericAgentTaskRequest](GenericAgentTaskMessageArg),
	)
	r.Register(
		decoder.RegistryKey{OPType: "GENERIC_AGENT_TASK", OPCommand: "COMPUTE", Kind: decoder.KindResult},
		decoder.NewJSONDecoder[GenericAgentTaskResponse](),
	)
}

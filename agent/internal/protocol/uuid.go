package protocol

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
)

// Namespace shared with the backend (src/server/modules/commands/command.service.ts).
// Changing it would break correlation between agent results and server rows.
const commandNamespace = "8b1d6a6e-4a1f-4c7e-9d2b-6f0e5a3c1b74"

// DeriveCommandID reproduces the server's uuidv5(batchId:deviceId) exactly.
//
// A broadcast carries only the batch id: each agent computes its own command id
// from the batch plus its own device id, so one publish can serve the whole
// group while every device still maps to a distinct, pre-inserted history row.
func DeriveCommandID(batchID, deviceID string) string {
	return uuidV5(commandNamespace, batchID+":"+deviceID)
}

func uuidV5(namespace, name string) string {
	ns, err := parseUUID(namespace)
	if err != nil {
		return ""
	}
	h := sha1.New()
	h.Write(ns)
	h.Write([]byte(name))
	sum := h.Sum(nil)[:16]

	sum[6] = (sum[6] & 0x0f) | 0x50 // version 5
	sum[8] = (sum[8] & 0x3f) | 0x80 // RFC 4122 variant

	return fmt.Sprintf("%x-%x-%x-%x-%x",
		sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
}

func parseUUID(s string) ([]byte, error) {
	var clean []byte
	for i := 0; i < len(s); i++ {
		if s[i] != '-' {
			clean = append(clean, s[i])
		}
	}
	if len(clean) != 32 {
		return nil, fmt.Errorf("invalid uuid %q", s)
	}
	return hex.DecodeString(string(clean))
}

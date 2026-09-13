// Package enroll exchanges a one-time enrollment token for MQTT credentials.
package enroll

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/zenstier/agent/internal/buildinfo"
	"github.com/zenstier/agent/internal/osinfo"
	"github.com/zenstier/agent/internal/protocol"
)

type request struct {
	Hostname     string          `json:"hostname,omitempty"`
	OS           *protocol.OSInfo `json:"os,omitempty"`
	AgentVersion string          `json:"agent_version,omitempty"`
}

type MQTTCreds struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type Response struct {
	DeviceID string    `json:"device_id"`
	MQTT     MQTTCreds `json:"mqtt"`
	CAPem    string    `json:"ca_pem"`
	Groups   []string  `json:"groups"`
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// Enroll posts the host facts and the token to the dashboard API.
func Enroll(serverURL, token string) (*Response, error) {
	facts := osinfo.Cached()
	body, err := json.Marshal(request{
		Hostname:     facts.Hostname,
		OS:           facts,
		AgentVersion: buildinfo.Version,
	})
	if err != nil {
		return nil, err
	}

	endpoint := strings.TrimRight(serverURL, "/") + "/api/v1/agent/enroll"
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "zenstier-agent/"+buildinfo.Version)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("contact server: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		var apiErr apiError
		if json.Unmarshal(raw, &apiErr) == nil && apiErr.Message != "" {
			return nil, fmt.Errorf("%s (%s)", apiErr.Message, apiErr.Error)
		}
		return nil, fmt.Errorf("server returned %s", resp.Status)
	}

	var out Response
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if out.DeviceID == "" || out.MQTT.Password == "" {
		return nil, fmt.Errorf("server returned an incomplete enrollment")
	}
	return &out, nil
}

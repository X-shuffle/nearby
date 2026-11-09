package httpapi

import (
	"encoding/json"
	"log/slog"

	discovery "nearby/internal/discovery/domain"
	"nearby/internal/session/application"
)

// logCommand records operation metadata, never raw payloads, invite tokens or SDP/ICE data.
func (s *Server) logCommand(logger *slog.Logger, command application.Command, events []application.Delivery, err error) {
	if command.Type == "ping" && err == nil {
		return
	}
	attrs := []any{"action", command.Type, "peer_id", command.PeerID}
	if err != nil {
		logger.Warn("device.command", append(attrs, "result", "error", "error", err)...)
		return
	}
	attrs = append(attrs, "result", "ok")
	if command.Type == "signal" {
		var payload struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(command.Payload, &payload) == nil {
			attrs = append(attrs, "signal_kind", payload.Kind)
		}
	}
	for _, delivery := range events {
		switch delivery.Event.Type {
		case "self.updated":
			if device, ok := delivery.Event.Payload.(discovery.Device); ok {
				attrs = append(attrs, "new_name", device.Name)
			}
		case "invite.joined":
			if payload, ok := delivery.Event.Payload.(map[string]any); ok {
				attrs = append(attrs, "inviter_id", payload["peerId"])
			}
		}
	}
	logger.Info("device.command", attrs...)
}

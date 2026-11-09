.PHONY: install build test dev server
install:
	npm ci
	go mod download
build:
	npm run build
	go build -trimpath -o bin/nearby ./cmd/server
test:
	go test -race ./...
	npm run build
	npm run test:e2e
dev:
	npm run dev
server:
	go run ./cmd/server

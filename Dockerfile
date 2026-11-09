FROM node:24-alpine AS frontend
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts playwright.config.ts ./
COPY e2e ./e2e
COPY web ./web
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go ./web/embed.go
COPY --from=frontend /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /nearby ./cmd/server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S nearby && adduser -S nearby -G nearby
COPY --from=backend /nearby /usr/local/bin/nearby
USER nearby
EXPOSE 15789
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:15789/api/health || exit 1
ENTRYPOINT ["nearby"]

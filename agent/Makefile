# Zenstier agent build.
# Go is not required on the host: everything runs in the golang container.

VERSION ?= 0.1.0
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
GOIMAGE ?= golang:alpine

LDFLAGS = -s -w \
  -X github.com/zenstier/agent/internal/buildinfo.Version=$(VERSION) \
  -X github.com/zenstier/agent/internal/buildinfo.Commit=$(COMMIT) \
  -X github.com/zenstier/agent/internal/buildinfo.Date=$(DATE)

DOCKER_RUN = docker run --rm \
  -v $(CURDIR):/src -w /src \
  -v zenstier-gomod:/go/pkg/mod \
  -v zenstier-gocache:/root/.cache/go-build \
  -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
  $(GOIMAGE)

.PHONY: all build build-all test vet tidy clean checksums

all: build-all checksums

tidy:
	$(DOCKER_RUN) go mod tidy

vet:
	$(DOCKER_RUN) go vet ./...

test:
	$(DOCKER_RUN) go test ./...

build:
	$(DOCKER_RUN) sh -c 'GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/zenstier-linux-amd64 ./cmd/zenstier'

# Go cross-compiles natively, so one amd64 container builds both arches.
build-all:
	$(DOCKER_RUN) sh -c 'for a in amd64 arm64; do \
	    GOOS=linux GOARCH=$$a go build -trimpath -ldflags "$(LDFLAGS)" \
	      -o dist/zenstier-linux-$$a ./cmd/zenstier || exit 1; \
	  done'

checksums:
	$(DOCKER_RUN) sh -c 'cd dist && sha256sum zenstier-linux-* > SHA256SUMS'

clean:
	rm -rf dist

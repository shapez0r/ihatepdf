VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build run test tidy docker up scale down rootfs clean

tidy:
	go mod tidy

build: tidy
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/ihatepdf ./cmd/ihatepdf

run: build
	./bin/ihatepdf serve

test: tidy
	go test ./...

docker:
	docker build --build-arg VERSION=$(VERSION) -t ihatepdf:$(VERSION) -t ihatepdf:latest .

up:
	docker compose up -d --build

scale:
	docker compose -f compose.scale.yaml up -d --build

down:
	docker compose down; docker compose -f compose.scale.yaml down

rootfs: build
	./deploy/microvm/build-rootfs.sh bin/ihatepdf dist/ihatepdf-rootfs.ext4

clean:
	rm -rf bin dist

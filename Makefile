SHELL := /bin/sh
.DEFAULT_GOAL := help

.PHONY: help install dev test typecheck build check e2e pack publish clean

help:
	@printf '%s\n' \
		'make install    Install dependencies' \
		'make dev        Start the UI development server' \
		'make test       Run tests' \
		'make typecheck  Run TypeScript checks' \
		'make build      Build all distributable files' \
		'make check      Run typecheck, build, and tests' \
		'make e2e        Run the real-opencode end-to-end suite' \
		'make pack       Build and preview the npm package' \
		'make publish    Verify and publish to npm' \
		'make clean      Remove generated build output'

install:
	bun install

dev:
	bunx vite --config ui/vite.config.ts

test:
	bun test

typecheck:
	bun run typecheck

build:
	bun run build

check:
	bun run check

e2e:
	bash tests/e2e/run.sh

pack: build
	npm pack --dry-run

publish:
	npm publish --access public

clean:
	rm -rf dist

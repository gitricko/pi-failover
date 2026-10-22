
minions-install:
	curl -fsSL https://github.com/gitricko/.minions/raw/refs/heads/main/install.sh | bash

minions-boot:
	~/.minions/boot.sh

minions-self-check:
	~/.minions/self-check.sh

version-check:
	./scripts/check-pi-version.sh

version-update:
	echo "bump devDependencies (or let dependabot open the PR)"
	npm install && npm run build
	npx tsc -p tsconfig.json --noEmit
	./scripts/integration-test.sh
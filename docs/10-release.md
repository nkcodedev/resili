# Release & npm Publish

## Before Release
- Run lint
- Run tests
- Run coverage
- Update CHANGELOG
- Update README

## Build

```bash
npm run build
```

## Verify

```bash
npm pack
```

Install the generated tarball locally and verify exports and typings.

## Publish

```bash
npm login
npm publish --access public
```

## CI/CD
GitHub Actions should:
- lint
- test
- build
- verify package
- publish on tagged release
